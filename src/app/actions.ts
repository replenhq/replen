"use server";

import { db, schema } from "@/db/client";
import { and, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireWritableUser } from "@/lib/auth/demo-mode";
import { readUserSecret } from "@/lib/user-secrets";
import { errorMsg } from "@/lib/error-msg";
import { createHandoffPR, fetchPrState } from "@/lib/github-pr";
import { handoffBranchName, handoffFilePath, renderHandoff, sanitizePrTitle } from "@/lib/handoff-template";
import { startPipelineForUser } from "@/scheduler/run-once";
import { proposeDocsImprovement } from "@/projects/self-improvement";
import { generateProjectSummary, PROMPT_VERSION } from "@/projects/summarize";
import { resolveUserConfig } from "@/scheduler/user-config";
import { withRunConfig } from "@/analyzer/run-context";

// 'bookmarked' is the user-status for general-awareness matches the user is
// "saving for later". It's semantically distinct from 'starred' (which is the
// "I want to act on this" signal for high/medium matches) — see
// docs/bookmark-resurface-scope.md. The setMatchStatus action enforces the
// rule: 'starred' is rejected on general-awareness rows, 'bookmarked' is
// rejected on non-general-awareness rows.
const ALLOWED_STATUSES = new Set(["unread", "hidden", "starred", "bookmarked"]);
const ALLOWED_FEEDBACK = new Set(["good", "bad", "clear"]);
const MIN_RUN_GAP_MS = 60_000;

// Manually triggers the pipeline for the current user. Used by the dashboard
// refresh button and the /runs "Run now" button. Silently no-ops if a run is
// already in flight or if the previous run finished less than 60s ago — the
// dashboard query controls the visual gate, so the user doesn't see a
// confusing error.
export async function runPipelineNow(): Promise<void> {
  const user = await requireWritableUser();
  const inFlight = await db
    .select({ id: schema.digestRuns.id })
    .from(schema.digestRuns)
    .where(and(eq(schema.digestRuns.userId, user.id), isNull(schema.digestRuns.finishedAt)))
    .get();
  if (inFlight) {
    console.warn(`[runPipelineNow] user=${user.id} already has run ${inFlight.id} in flight`);
    return;
  }
  const cutoff = new Date(Date.now() - MIN_RUN_GAP_MS);
  const recent = await db
    .select({ id: schema.digestRuns.id })
    .from(schema.digestRuns)
    .where(and(eq(schema.digestRuns.userId, user.id), gte(schema.digestRuns.startedAt, cutoff)))
    .get();
  if (recent) {
    console.warn(`[runPipelineNow] user=${user.id} ran within last ${MIN_RUN_GAP_MS / 1000}s; rejecting`);
    return;
  }
  // Await the row insert (not the full pipeline) so revalidatePath sees the
  // in-flight run on the very next render and the LivePipelineStatus strip
  // appears immediately instead of waiting up to 2.5s for the first poll.
  await startPipelineForUser(user.id);
  revalidatePath("/");
  revalidatePath("/runs");
}

export async function setMatchFeedback(matchId: number, value: string) {
  const user = await requireWritableUser();
  if (!ALLOWED_FEEDBACK.has(value)) throw new Error(`invalid feedback: ${value}`);
  if (!Number.isInteger(matchId) || matchId <= 0) throw new Error("invalid matchId");
  await db
    .update(schema.matches)
    .set({ userFeedback: value === "clear" ? null : value })
    .where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, user.id)));
  revalidatePath("/");
  revalidatePath("/starred");
}

export async function setPersonalNote(matchId: number, note: string) {
  const user = await requireWritableUser();
  if (!Number.isInteger(matchId) || matchId <= 0) throw new Error("invalid matchId");
  const trimmed = (note ?? "").slice(0, 2000);
  await db
    .update(schema.matches)
    .set({ personalNote: trimmed || null })
    .where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, user.id)));
  revalidatePath("/");
  revalidatePath("/starred");
}

export async function setMatchStatus(matchId: number, status: string) {
  const user = await requireWritableUser();
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  if (!Number.isInteger(matchId) || matchId <= 0) throw new Error("invalid matchId");
  // Enforce intent split: 'starred' = action item (high/medium); 'bookmarked'
  // = save-for-later (general-awareness). The UI keys the button off relevance
  // and only ever sends the right value, but a server-side guard keeps the
  // data clean if a stale tab sends the wrong one.
  if (status === "starred" || status === "bookmarked") {
    const row = await db
      .select({ relevance: schema.matches.relevance })
      .from(schema.matches)
      .where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, user.id)))
      .get();
    if (!row) throw new Error("match not found");
    if (status === "starred" && row.relevance === "general-awareness") {
      throw new Error("general-awareness matches use 'bookmarked', not 'starred'");
    }
    if (status === "bookmarked" && row.relevance !== "general-awareness") {
      throw new Error("only general-awareness matches can be bookmarked");
    }
  }
  await db
    .update(schema.matches)
    .set({ userStatus: status })
    .where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, user.id)));
  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath("/starred");
}

// Initiative #3: status changes for synthesised insights. Three states:
// 'unread' (default), 'starred' (pin / keep visible), 'hidden' (dismissed
// from feed). Separate from matches.user_status so the user can hide an
// insight without affecting any of the matches it cites.
const ALLOWED_INSIGHT_STATUSES = new Set(["unread", "starred", "hidden"]);

export async function setInsightStatus(insightId: number, status: string) {
  const user = await requireWritableUser();
  if (!ALLOWED_INSIGHT_STATUSES.has(status)) throw new Error(`invalid insight status: ${status}`);
  if (!Number.isInteger(insightId) || insightId <= 0) throw new Error("invalid insightId");
  await db
    .update(schema.matchInsights)
    .set({ userStatus: status })
    .where(and(eq(schema.matchInsights.id, insightId), eq(schema.matchInsights.userId, user.id)));
  revalidatePath("/");
}

export async function createHandoff(matchId: number): Promise<{ ok: boolean; prUrl?: string; reason?: string }> {
  const user = await requireWritableUser();
  if (!Number.isInteger(matchId) || matchId <= 0) throw new Error("invalid matchId");

  const match = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, user.id)))
    .get();
  if (!match) return { ok: false, reason: "match not found" };
  if (match.handoffPrUrl) {
    return { ok: true, prUrl: match.handoffPrUrl, reason: "already exists" };
  }
  if (!match.projectId) return { ok: false, reason: "match is _general (no project to commit to)" };

  const project = await db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, match.projectId)).get();
  if (!project?.githubFullName) {
    return { ok: false, reason: "set this project's GitHub repo on /projects first" };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(project.githubFullName)) {
    return { ok: false, reason: "invalid github_full_name format (want owner/name)" };
  }

  const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, match.repoId)).get();
  if (!repo) return { ok: false, reason: "repo missing" };

  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  // githubWriteToken fallback for legacy rows on the old two-field schema.
  const tokenStored = settings?.githubToken ?? settings?.githubWriteToken ?? null;
  const writeToken = tokenStored ? await safeReadSecret(user.id, "githubToken", tokenStored, "create-handoff") : null;
  if (!writeToken) return { ok: false, reason: "add a GitHub PAT on /settings first (Contents: write + Pull requests: write)" };

  const filePath = handoffFilePath(repo.owner, repo.name);
  const branch = handoffBranchName(repo.owner, repo.name);
  const fileContent = renderHandoff(
    match,
    { owner: repo.owner, name: repo.name, url: repo.url, stars: repo.stars, primaryLanguage: repo.primaryLanguage, license: repo.license },
    project.slug,
    filePath,
  );
  const prTitle = sanitizePrTitle(`Handoff: ${repo.owner}/${repo.name}`);
  const safeOwner = repo.owner.replace(/[`\n]/g, "");
  const safeName = repo.name.replace(/[`\n]/g, "");
  const safeSlug = project.slug.replace(/[`\n]/g, "");
  const safeFile = filePath.replace(/[`\n]/g, "");
  const safeRelevance = String(match.relevance).replace(/[`\n]/g, "");
  const scoreSuffix = match.relevanceScore != null ? ` (${match.relevanceScore})` : "";
  // Brand footer: short, on-voice, inline-linked. The dashboard link is the
  // user's own Replen install (PUBLIC_BASE_URL); reviewers click through to see
  // why the match surfaced. We keep the body tight — the handoff brief itself
  // (committed at filePath) carries the detailed reasoning, so the PR body
  // doesn't need to repeat it.
  const dashboard = process.env.PUBLIC_BASE_URL ?? null;
  const brandLine = dashboard
    ? `— [Replen](${dashboard}) · _The AI that asks, "can we do this better?"_`
    : `— Replen · _The AI that asks, "can we do this better?"_`;

  const prBody = `**Replen thinks \`${safeOwner}/${safeName}\` could improve \`${safeSlug}\`.**

This PR drops a handoff brief at \`${safeFile}\`. It's the why — what this repo is, what it would give you, and the smallest first step — plus a starter prompt for Claude Code / Codex to evaluate the integration against your actual codebase.

- Repo: ${repo.url}
- Match: ${safeRelevance}${scoreSuffix}
- Project: \`${safeSlug}\`

${brandLine}`;

  let result;
  try {
    result = await createHandoffPR({
      token: writeToken,
      ownerRepo: project.githubFullName,
      filePath,
      fileContent,
      branch,
      prTitle,
      prBody,
    });
  } catch (e) {
    console.error("[createHandoff]", e);
    return { ok: false, reason: errorMsg(e) || "github api error" };
  }

  if (result.skipped === "file_exists") {
    return { ok: false, reason: `${filePath} already exists on the default branch - skipped` };
  }

  await db
    .update(schema.matches)
    .set({ handoffPrUrl: result.prUrl, handoffCreatedAt: new Date() })
    .where(eq(schema.matches.id, matchId));
  revalidatePath("/");
  return { ok: true, prUrl: result.prUrl };
}

async function safeReadSecret(
  userId: number,
  column: string,
  stored: string,
  reason: Parameters<typeof readUserSecret>[3],
): Promise<string | null> {
  try { return await readUserSecret(userId, column, stored, reason); } catch { return null; }
}

// Aging policy: soft-delete hidden matches older than `days` for the caller.
// Soft (sets archivedAt) so we can resurrect later if a user wants - the
// dashboard filter ignores archived rows. Defaults to 90 days. Floor is 30:
// callers passing `0` or a small number must not be able to archive recently-
// hidden matches (which could otherwise be used to wipe a tenant's history
// via a single misuse of the form).
export async function archiveOldHidden(days: number = 90): Promise<{ ok: boolean; archived: number }> {
  const user = await requireWritableUser();
  const safeDays = Math.max(Number.isFinite(days) ? Math.floor(days) : 90, 30);
  const cutoff = new Date(Date.now() - safeDays * 86400_000);
  const res = await db
    .update(schema.matches)
    .set({ archivedAt: new Date() })
    .where(and(
      eq(schema.matches.userId, user.id),
      eq(schema.matches.userStatus, "hidden"),
      lt(schema.matches.createdAt, cutoff),
      isNull(schema.matches.archivedAt),
    ));
  revalidatePath("/");
  revalidatePath("/starred");
  return { ok: true, archived: (res as { changes?: number }).changes ?? 0 };
}

// Bulk unstar - accepts a list of match IDs and clears userStatus on all that
// belong to the caller. Used by the "Unstar selected" button on /starred.
export async function bulkUnstar(matchIds: number[]): Promise<{ ok: boolean; updated: number }> {
  const user = await requireWritableUser();
  const ids = matchIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { ok: true, updated: 0 };
  let updated = 0;
  for (const id of ids) {
    const res = await db
      .update(schema.matches)
      .set({ userStatus: "unread" })
      .where(and(eq(schema.matches.id, id), eq(schema.matches.userId, user.id), eq(schema.matches.userStatus, "starred")));
    updated += (res as { changes?: number }).changes ?? 0;
  }
  revalidatePath("/starred");
  revalidatePath("/");
  return { ok: true, updated };
}

// Bulk handoff PR - opens a PR for every starred match in the list that
// doesn't already have one. Sequential because each call talks to GitHub and
// we'd hit the secondary-rate-limit fanning out.
export async function bulkCreateHandoffs(matchIds: number[]): Promise<{ ok: boolean; opened: number; skipped: number; failures: string[] }> {
  await requireWritableUser();
  const ids = matchIds.filter((n) => Number.isInteger(n) && n > 0);
  let opened = 0, skipped = 0;
  const failures: string[] = [];
  for (const id of ids) {
    try {
      const r = await createHandoff(id);
      if (r.ok && r.prUrl) opened++;
      else { skipped++; if (r.reason) failures.push(`#${id}: ${r.reason}`); }
    } catch (e) {
      skipped++;
      failures.push(`#${id}: ${(e as Error).message}`);
    }
  }
  revalidatePath("/starred");
  return { ok: true, opened, skipped, failures };
}

// Polls every handoff PR's state on GitHub and updates handoffPrStatus +
// integratedAt. Used by the "refresh" button on /starred and /integrated.
// Rate-limited by GitHub's per-token limit (5000/h on classic / fine-grained),
// so we cap polling to PRs that have been checked > 30 minutes ago.
export async function refreshHandoffStatuses(): Promise<{ ok: boolean; checked: number; merged: number; reason?: string }> {
  const user = await requireWritableUser();
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  const tokenStored = settings?.githubToken ?? settings?.githubWriteToken ?? null;
  const token = tokenStored ? await safeReadSecret(user.id, "githubToken", tokenStored, "create-handoff") : null;
  if (!token) return { ok: false, checked: 0, merged: 0, reason: "no PAT on file" };

  const halfHourAgo = new Date(Date.now() - 30 * 60_000);
  const rows = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, user.id), isNotNull(schema.matches.handoffPrUrl)));
  const candidates = rows.filter((r) => !r.handoffPrCheckedAt || +r.handoffPrCheckedAt < +halfHourAgo);

  let merged = 0;
  for (const r of candidates) {
    const state = await fetchPrState(token, r.handoffPrUrl!);
    const set: Partial<typeof schema.matches.$inferInsert> = {
      handoffPrStatus: state === "missing" ? r.handoffPrStatus : state,
      handoffPrCheckedAt: new Date(),
    };
    if (state === "merged" && !r.integratedAt) {
      set.integratedAt = new Date();
      merged++;
    }
    await db.update(schema.matches).set(set).where(eq(schema.matches.id, r.id));
  }
  revalidatePath("/starred");
  revalidatePath("/integrated");
  revalidatePath("/");
  return { ok: true, checked: candidates.length, merged };
}

// Manually regenerate the Stage-1 project summary for one project. Used by
// the "Recompute" button on /projects/[slug]. Returns the resulting summary
// (or null if the project has no docs at all).
export async function recomputeProjectSummary(projectId: number): Promise<{ ok: boolean; reason?: string }> {
  const user = await requireWritableUser();
  if (!Number.isInteger(projectId) || projectId <= 0) throw new Error("invalid projectId");
  const project = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.id, projectId), eq(schema.projectProfiles.userId, user.id)))
    .get();
  if (!project) return { ok: false, reason: "project not found" };

  const cfg = await resolveUserConfig(user.id);
  const summary = await withRunConfig(
    {
      llmPrimaryApiKey: cfg.llmPrimaryApiKey,
      llmPrimaryBaseUrl: cfg.llmPrimaryBaseUrl,
      llmPrimaryModel: cfg.llmPrimaryModel,
      deepseekApiKey: cfg.deepseekApiKey,
    },
    () =>
      generateProjectSummary({
        name: project.name,
        slug: project.slug,
        readmeMd: project.readmeMd,
        claudeMd: project.claudeMd,
        techSummary: project.techSummary,
      }),
  );
  if (!summary) {
    return { ok: false, reason: "project has no docs and no techSummary — nothing to summarize" };
  }
  await db
    .update(schema.projectProfiles)
    .set({
      summaryJson: JSON.stringify(summary),
      summaryHash: project.profileHash,
      summaryGeneratedAt: new Date(),
      summaryPromptVersion: PROMPT_VERSION,
    })
    .where(eq(schema.projectProfiles.id, project.id));
  revalidatePath(`/projects/${project.slug}`);
  revalidatePath("/projects");
  return { ok: true };
}

// "Open a docs-improvement PR for this project" — triggered from the
// /projects/[slug] callout when Replen has detected sparse docs.
// Thin wrapper over proposeDocsImprovement so the UI gets a server action
// with the same shape as createHandoff.
export async function openDocsImprovementPR(projectId: number): Promise<{ ok: boolean; prUrl?: string; reason?: string }> {
  const user = await requireWritableUser();
  if (!Number.isInteger(projectId) || projectId <= 0) throw new Error("invalid projectId");
  const result = await proposeDocsImprovement(user.id, projectId);
  if (result.ok) {
    revalidatePath(`/projects`);
    return { ok: true, prUrl: result.prUrl };
  }
  return { ok: false, reason: result.reason };
}

