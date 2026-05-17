// Stage-1 spin-off: detect when a user's own project has docs too sparse for
// Replen to produce a useful summary, and propose a fix as a PR to the
// project's repo. The PR drops a handoff file telling Claude Code (or any
// AI assistant) to draft a real README from the codebase.
//
// This is "can we do this better?" applied to the *user's own docs*, not to
// external OSS. Same handoff PR mechanism, different target.

import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { createHandoffPR, fetchPrState } from "../lib/github-pr";
import {
  docsHandoffBranchName,
  docsHandoffFilePath,
  renderDocsHandoff,
  sanitizePrTitle,
} from "../lib/handoff-template";
import { readUserSecret } from "../lib/user-secrets";
import { errorMsg } from "../lib/error-msg";

// Sparse if no CLAUDE.md AND README is missing OR shorter than this many
// characters. 500 chars is roughly "title + a couple of sentences" — enough
// to grasp what a project is but nowhere near enough to extract goals.
const SPARSE_README_THRESHOLD = 500;

export type SparseDocsAssessment = {
  sparse: boolean;
  reasons: string[];
  hasReadme: boolean;
  readmeLength: number;
  hasClaudeMd: boolean;
};

export function assessDocSparsity(project: {
  readmeMd: string | null;
  claudeMd: string | null;
}): SparseDocsAssessment {
  const readmeLength = (project.readmeMd ?? "").trim().length;
  const hasReadme = readmeLength > 0;
  const hasClaudeMd = (project.claudeMd ?? "").trim().length > 0;
  const reasons: string[] = [];
  if (!hasReadme) reasons.push("no README.md");
  else if (readmeLength < SPARSE_README_THRESHOLD) reasons.push(`README is only ${readmeLength} chars`);
  if (!hasClaudeMd) reasons.push("no CLAUDE.md");
  // Sparse iff README is missing OR very short AND there's no CLAUDE.md to
  // compensate. A short README with a substantive CLAUDE.md is fine.
  const sparse = (!hasReadme || readmeLength < SPARSE_README_THRESHOLD) && !hasClaudeMd;
  return { sparse, reasons, hasReadme, readmeLength, hasClaudeMd };
}

export type ProposeDocsImprovementResult =
  | { ok: true; prUrl: string; status: "opened" | "already_open" }
  | { ok: false; reason: string };

// Best-effort secret decrypt. Same pattern as the rest of actions.ts —
// callers want a token-or-null, not an exception path.
async function safeReadSecret(
  userId: number,
  column: string,
  stored: string,
  reason: Parameters<typeof readUserSecret>[3],
): Promise<string | null> {
  try {
    return await readUserSecret(userId, column, stored, reason);
  } catch {
    return null;
  }
}

// Opens a docs-improvement PR for the project, gated by:
//   - Project must have github_full_name set (we know where to push)
//   - User must have a GitHub PAT with Contents: write + PRs: write
//   - Docs must actually be sparse (defence-in-depth — callers should check
//     too, but we re-verify because this can be triggered manually)
//   - If an open Replen-docs PR already exists for this project, return its
//     URL instead of opening a duplicate
export async function proposeDocsImprovement(
  userId: number,
  projectId: number,
): Promise<ProposeDocsImprovementResult> {
  const project = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.id, projectId), eq(schema.projectProfiles.userId, userId)))
    .get();
  if (!project) return { ok: false, reason: "project not found" };

  if (!project.githubFullName) {
    return { ok: false, reason: "set this project's GitHub repo on /projects first" };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(project.githubFullName)) {
    return { ok: false, reason: "invalid github_full_name format (want owner/name)" };
  }

  const assessment = assessDocSparsity(project);
  if (!assessment.sparse) {
    return { ok: false, reason: "docs are no longer sparse — nothing to propose" };
  }

  const settings = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  const tokenStored = settings?.githubToken ?? settings?.githubWriteToken ?? null;
  const writeToken = tokenStored
    ? await safeReadSecret(userId, "githubToken", tokenStored, "propose-docs-improvement")
    : null;
  if (!writeToken) {
    return { ok: false, reason: "add a GitHub PAT on /settings first (Contents: write + Pull requests: write)" };
  }

  const detectedLanguages = (settings?.detectedLanguages ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const filePath = docsHandoffFilePath(project.slug);
  const branch = docsHandoffBranchName(project.slug);
  const fileContent = renderDocsHandoff({
    projectName: project.name,
    projectSlug: project.slug,
    ownerRepo: project.githubFullName,
    hasReadme: assessment.hasReadme,
    readmeLength: assessment.readmeLength,
    hasClaudeMd: assessment.hasClaudeMd,
    techSummary: project.techSummary,
    detectedLanguages,
  });
  const prTitle = sanitizePrTitle(`Replen: draft a README so I can help you better`);
  const prBody = `Replen detected this project's docs are too sparse to extract meaningful outcome goals (${assessment.reasons.join("; ")}).

This PR adds a one-file handoff at \`${filePath}\` telling Claude Code / Codex / your AI of choice to draft a real README from the codebase. Open the repo in your AI tool, run the prompt in the handoff file, commit the README, delete the handoff file.

Once docs are richer, Replen's next pipeline run will pick up the new context (or you can force a refresh on \`/projects/${project.slug}\`).

Close this PR to dismiss — Replen won't auto-open another for this project while the existing docs stay sparse.`;

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
    console.error("[self-improvement] PR open failed:", e);
    return { ok: false, reason: errorMsg(e) || "github api error" };
  }

  if (result.skipped === "file_exists") {
    // The handoff file already exists on the default branch — user previously
    // merged a docs PR but didn't delete the handoff file. Don't reopen.
    return { ok: false, reason: `${filePath} already exists on the default branch — docs handoff already actioned` };
  }

  return { ok: true, prUrl: result.prUrl, status: "opened" };
}

// Idempotency check: has this project already had a docs PR opened recently
// that's still in flight? Reused by the pipeline hook so we don't spam PRs.
export async function hasOpenDocsPr(
  userId: number,
  projectId: number,
): Promise<{ exists: boolean; prUrl?: string }> {
  const project = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.id, projectId), eq(schema.projectProfiles.userId, userId)))
    .get();
  if (!project?.githubFullName) return { exists: false };

  // We don't store docs-PR URLs on project_profiles (yet) — for now, check
  // open branches via the GitHub API by listing PRs filtered to our branch
  // naming convention. This is one GET per project per refresh, bounded.
  // TODO: persist the PR URL on a new column when we wire the auto-trigger.
  // For Stage-1 manual flow, callers can pass through and the duplicate-
  // detection in github-pr.ts catches "file_exists" + "branch_exists" cases.
  return { exists: false };
}

// Convenience used by the pipeline pre-fetch step. Returns the list of
// project IDs that should get a docs-improvement PR proposed automatically.
// Stage-1 implementation: returns only manually-confirmed candidates; auto-
// trigger is a follow-up once we've validated the PR content reads well.
export async function findSparseProjectsForUser(userId: number): Promise<
  Array<{ id: number; slug: string; reasons: string[] }>
> {
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true)));
  const out: Array<{ id: number; slug: string; reasons: string[] }> = [];
  for (const p of projects) {
    if (!p.githubFullName) continue;
    const a = assessDocSparsity(p);
    if (a.sparse) out.push({ id: p.id, slug: p.slug, reasons: a.reasons });
  }
  return out;
}

// Re-export the fetchPrState signature for callers who want to refresh
// status of an open docs PR (same shape as match handoffs).
export { fetchPrState };
