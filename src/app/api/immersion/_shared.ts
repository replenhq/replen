// Shared helpers for the hosted Immersion endpoints (M2). The manifest tells a
// client which grounded files to send; the ingest endpoint embeds what comes
// back. Both must agree on (a) which project a request targets, (b) that
// project's effective Immersion tier, and (c) the exact set of grounded paths
// the project's own capabilities cite — so they live here, once.
//
// MECHANICAL ONLY: no LLM. The sole server cost is the embedding call in
// ingest, identical to the descriptor-facet build.

import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { groundedFileTargets, type CodeTarget } from "@/projects/immersion";
import { resolveImmersionTier, type ImmersionTier } from "@/lib/immersion-tier";
import type { CapabilitySpec } from "@/projects/modality";
import type { ProjectSummary } from "@/projects/summarize";

export type ProjectRow = typeof schema.projectProfiles.$inferSelect;

export type ImmersionRequest = { githubFullName?: unknown; slug?: unknown };

/**
 * Resolve which of the caller's projects a request targets. Match on
 * github_full_name first (stable identity), then slug. Scoped to userId +
 * active so a token only ever touches its own live projects.
 */
export async function resolveProject(userId: number, body: ImmersionRequest): Promise<ProjectRow | null> {
  const gfn = typeof body.githubFullName === "string" ? body.githubFullName.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!gfn && !slug) return null;

  const rows = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true)));
  const byGfn = gfn ? rows.find((r) => (r.githubFullName ?? "").toLowerCase() === gfn.toLowerCase()) : undefined;
  if (byGfn) return byGfn;
  return (slug ? rows.find((r) => r.slug === slug) : undefined) ?? null;
}

/** Effective tier for a project given the account default + per-repo override. */
export function effectiveTier(accountTier: string | null | undefined, project: ProjectRow): ImmersionTier {
  return resolveImmersionTier({ accountTier, repoTier: project.immersionTier });
}

/** The grounded-file targets a project's capabilities cite (deny/ext filtered). */
export function targetsFor(project: ProjectRow): CodeTarget[] {
  let summary: ProjectSummary | null = null;
  if (project.summaryJson) {
    try { summary = JSON.parse(project.summaryJson) as ProjectSummary; } catch { /* none */ }
  }
  const specs: CapabilitySpec[] = (summary?.capabilities ?? []).filter((c) => c?.paths?.length);
  return groundedFileTargets(specs);
}
