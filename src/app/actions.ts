"use server";

import { db, schema } from "@/db/client";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { decryptSecret } from "@/lib/crypto";
import { createHandoffPR, fetchPrState } from "@/lib/github-pr";
import { handoffBranchName, handoffFilePath, renderHandoff } from "@/lib/handoff-template";

const ALLOWED_STATUSES = new Set(["unread", "hidden", "starred"]);
const ALLOWED_FEEDBACK = new Set(["good", "bad", "clear"]);

export async function setMatchFeedback(matchId: number, value: string) {
  const user = await requireUser();
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
  const user = await requireUser();
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
  const user = await requireUser();
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  if (!Number.isInteger(matchId) || matchId <= 0) throw new Error("invalid matchId");
  await db
    .update(schema.matches)
    .set({ userStatus: status })
    .where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, user.id)));
  revalidatePath("/");
  revalidatePath("/projects");
}

export async function createHandoff(matchId: number): Promise<{ ok: boolean; prUrl?: string; reason?: string }> {
  const user = await requireUser();
  if (!Number.isInteger(matchId) || matchId <= 0) throw new Error("invalid matchId");

  // 1. Validate ownership + gather context.
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
  // Single PAT model: prefer githubToken, fall back to githubWriteToken for
  // anyone still on the old two-field schema.
  const tokenStored = settings?.githubToken ?? settings?.githubWriteToken ?? null;
  const writeToken = tokenStored ? safeDec(tokenStored) : null;
  if (!writeToken) return { ok: false, reason: "add a GitHub PAT on /settings first (Contents: write + Pull requests: write)" };

  // 2. Render the file + PR metadata.
  const filePath = handoffFilePath(repo.owner, repo.name);
  const branch = handoffBranchName(repo.owner, repo.name);
  const fileContent = renderHandoff(
    match,
    { owner: repo.owner, name: repo.name, url: repo.url, stars: repo.stars, primaryLanguage: repo.primaryLanguage, license: repo.license },
    project.slug,
    filePath,
  );
  const prTitle = `Handoff: ${repo.owner}/${repo.name}`;
  const prBody = `Automated handoff from replen.

This PR adds \`${filePath}\` describing why \`${repo.owner}/${repo.name}\` surfaced as a potential fit for \`${project.slug}\`, plus a prompt for Claude Code / Codex to re-evaluate it with knowledge of this codebase.

Source: ${repo.url}
Match relevance: ${match.relevance}${match.relevanceScore != null ? ` (${match.relevanceScore})` : ""}

Merge or close — either way the next handoff goes into its own PR.`;

  // 3. Open the PR.
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
    return { ok: false, reason: (e as any)?.message ?? "github api error" };
  }

  if (result.skipped === "file_exists") {
    return { ok: false, reason: `${filePath} already exists on the default branch — skipped` };
  }

  // 4. Persist the PR URL so the UI knows not to re-offer the button.
  await db
    .update(schema.matches)
    .set({ handoffPrUrl: result.prUrl, handoffCreatedAt: new Date() })
    .where(eq(schema.matches.id, matchId));
  revalidatePath("/");
  return { ok: true, prUrl: result.prUrl };
}

function safeDec(stored: string): string | null {
  try { return decryptSecret(stored); } catch { return null; }
}

// Aging policy: soft-delete hidden matches older than `days` for the caller.
// Soft (sets archivedAt) so we can resurrect later if a user wants — the
// dashboard filter ignores archived rows. Defaults to 90 days.
export async function archiveOldHidden(days: number = 90): Promise<{ ok: boolean; archived: number }> {
  const user = await requireUser();
  const cutoff = new Date(Date.now() - days * 86400_000);
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

// Bulk unstar — accepts a list of match IDs and clears userStatus on all that
// belong to the caller. Used by the "Unstar selected" button on /starred.
export async function bulkUnstar(matchIds: number[]): Promise<{ ok: boolean; updated: number }> {
  const user = await requireUser();
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

// Bulk handoff PR — opens a PR for every starred match in the list that
// doesn't already have one. Sequential because each call talks to GitHub and
// we'd hit the secondary-rate-limit fanning out.
export async function bulkCreateHandoffs(matchIds: number[]): Promise<{ ok: boolean; opened: number; skipped: number; failures: string[] }> {
  await requireUser();
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
  const user = await requireUser();
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  const tokenStored = settings?.githubToken ?? settings?.githubWriteToken ?? null;
  const token = tokenStored ? safeDec(tokenStored) : null;
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
