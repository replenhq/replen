// Stage 4 source-context retrieval.
//
// Given a candidate repo we've already cloned + indexed, pull the source
// excerpts most relevant to the outcome we're verifying against. The result
// is a prompt block we append to scoreTargetedCandidate's user message — so
// the LLM judges based on what the codebase actually does, not just what the
// README claims (or doesn't claim — Firebase Studio stub READMEs are why this
// exists).
//
// Query strategy: simple multi-query union. We run 2-3 short queries derived
// from the attribution (the outcome verbatim and the matched search term) and
// merge results by score. No re-prompting the LLM for queries — cheap, fast,
// good enough as a first pass. If we find Stage 4 needs more targeted queries
// later, we can add a "pick keywords" mini-LLM call.

import { buildIndex, findFreshIndex, loadIndex, searchLoadedIndex, type SearchHit } from "../lib/repo-index";
import { shallowClone } from "../lib/repo-index/clone";
import { scoreTargetedCandidate, type TargetedAssessment, type TargetedAttribution } from "./score-targeted";
import type { SafetyReport } from "../scanner/safety";
import type { LocalProject } from "../projects/loader";
import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";

export type SourceExcerptOpts = {
  /** Cap on the number of excerpts returned across all queries. */
  maxExcerpts?: number;
  /** Cap on bytes per excerpt's content; truncate the middle if longer. */
  maxBytesPerExcerpt?: number;
};

const DEFAULT_MAX_EXCERPTS = 8;
const DEFAULT_MAX_BYTES = 700;

/**
 * Ensure an index exists for `repoId` against the source tree at `path`.
 * Reuses the latest index for INDEX_VERSION if present, otherwise builds one.
 * Returns the indexId to feed into searchIndex.
 */
export async function ensureRepoIndex(
  repoId: number,
  path: string,
  opts: { readmeSha?: string | null } = {},
): Promise<number> {
  const fresh = await findFreshIndex(repoId, opts.readmeSha ?? null);
  if (fresh) return fresh.indexId;
  const built = await buildIndex(repoId, path, { readmeSha: opts.readmeSha });
  return built.indexId;
}

/**
 * Retrieve source excerpts relevant to the attribution. Runs the outcome and
 * matched-term as separate queries, merges by score, dedupes per file, then
 * truncates to the budget. Returns formatted excerpts ready to drop into the
 * Stage 4 prompt.
 */
export async function retrieveSourceExcerpts(
  indexId: number,
  attribution: { outcome: string; matchedTerm: string },
  techSummary: string | null,
  opts: SourceExcerptOpts = {},
): Promise<{ excerpts: FormattedExcerpt[]; queries: string[] }> {
  const maxExcerpts = opts.maxExcerpts ?? DEFAULT_MAX_EXCERPTS;
  const maxBytes = opts.maxBytesPerExcerpt ?? DEFAULT_MAX_BYTES;

  // Build the query list. Each query is independently meaningful — the BM25
  // tokeniser will split into terms, so phrasing matters less than vocabulary.
  // We pass the outcome as-is (rich vocabulary) and the matched term (sharp
  // intent), plus tech keywords when the project actually states them.
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(trimmed);
  };
  push(attribution.outcome);
  push(attribution.matchedTerm);
  if (techSummary) {
    // Tech summary is often a comma/space-separated list of stack words; pass
    // a slice of it. Not full text — that would dilute the query.
    push(techSummary.slice(0, 200));
  }

  // perQueryTopK is generous so the dedupe + score-merge has headroom. We
  // ultimately keep only `maxExcerpts` across all queries.
  const perQueryTopK = Math.max(maxExcerpts, 6);
  // Load the BM25 postings + doc lengths once and reuse across all queries.
  // Each call to searchIndex would otherwise re-pull every term posting from
  // SQLite — for a candidate with 10k+ chunks that's the dominant cost.
  const index = await loadIndex(indexId);
  const merged = new Map<number, SearchHit>();
  for (const q of queries) {
    const hits = await searchLoadedIndex(index, q, perQueryTopK);
    for (const h of hits) {
      const existing = merged.get(h.chunkId);
      // When the same chunk comes back from multiple queries, take the max
      // score — represents the strongest signal we have for it.
      if (!existing || h.score > existing.score) merged.set(h.chunkId, h);
    }
  }

  // One excerpt per file: keep the highest-scoring chunk per filePath so the
  // LLM sees breadth of evidence (different files) rather than three chunks
  // from the same file. Stage 4's job is fit assessment, not deep code review.
  const byFile = new Map<string, SearchHit>();
  for (const h of merged.values()) {
    const existing = byFile.get(h.filePath);
    if (!existing || h.score > existing.score) byFile.set(h.filePath, h);
  }
  const ranked = Array.from(byFile.values()).sort((a, b) => b.score - a.score).slice(0, maxExcerpts);

  const excerpts: FormattedExcerpt[] = ranked.map((h) => ({
    filePath: h.filePath,
    startLine: h.startLine,
    endLine: h.endLine,
    language: h.language,
    score: h.score,
    content: truncateMiddle(h.content, maxBytes),
  }));
  return { excerpts, queries };
}

export type FormattedExcerpt = {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string | null;
  score: number;
  content: string;
};

/**
 * Render excerpts as a markdown block to append to the Stage-4 prompt. Empty
 * input returns null so the caller can omit the block entirely (the LLM
 * doesn't need an empty "(no excerpts)" placeholder).
 */
export function renderSourceBlock(excerpts: FormattedExcerpt[]): string | null {
  if (excerpts.length === 0) return null;
  const parts: string[] = [
    `## Candidate repo: source excerpts`,
    ``,
    `The following code excerpts were retrieved from the candidate repo's source via BM25 search using the outcome and matched term as queries. Use them to verify whether the repo actually does what the README claims — especially when the README is sparse or generic. A repo that pattern-matches on keywords in its README but has no corresponding source is likely not a real fit.`,
    ``,
  ];
  for (const e of excerpts) {
    parts.push(`### ${e.filePath}:${e.startLine}-${e.endLine}${e.language ? ` (${e.language})` : ""}`);
    parts.push("```");
    parts.push(e.content);
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
}

// Truncate by keeping the head and tail and inserting an ellipsis marker in
// the middle. Beginning of a chunk usually has structure (imports, class
// signature); end often has the punchline (return, export). Middle is the
// safest part to drop for a quick excerpt.
function truncateMiddle(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const half = Math.floor((maxBytes - 12) / 2);
  return `${s.slice(0, half)}\n… [truncated] …\n${s.slice(-half)}`;
}

/**
 * Two-pass scoring with optional source-context verification.
 *
 * The first pass calls scoreTargetedCandidate against README + metadata only
 * (cheap, ~10-15s LLM call). If that returns "general-awareness" the LLM has
 * already cleanly rejected the candidate — the source-context pass would only
 * confirm what we know, so we skip the clone/index/retrieve overhead entirely.
 *
 * If the first pass returns "medium" or "high" we treat that as a claim worth
 * verifying: clone the repo, build the index (or reuse if it exists), retrieve
 * source excerpts, and re-score with them. The LLM is instructed by the
 * system prompt to treat source as ground truth and the README as a claim, so
 * a baseline-high verdict can be downgraded when the source doesn't back it up.
 *
 * The fallback path (verification fails midway — clone error, no excerpts,
 * scorer returns null) returns the baseline verdict unchanged. We never want
 * verification failure to be worse than no verification.
 */
export async function scoreWithSourceVerification(
  safety: SafetyReport,
  project: LocalProject,
  attribution: TargetedAttribution,
  opts: { token?: string | null; force?: boolean; forceApproach?: "cleanroom-rebuild" } = {},
): Promise<TargetedAssessment | null> {
  const baseline = await scoreTargetedCandidate(safety, project, attribution, { forceApproach: opts.forceApproach });
  if (!baseline) return null;

  // Gate: skip verification on clear rejections unless the caller forces it.
  // This is the cost-control knob — most candidates land here and we save
  // the indexer round-trip on every one of them.
  if (!opts.force && baseline.relevance === "general-awareness") return baseline;

  // Get or create the repos row so the index can be keyed against a stable id.
  const owner = safety.meta.owner;
  const name = safety.meta.name;
  const existing = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name)))
    .get();
  // Fall back to baseline if we can't anchor an index to a real repos row.
  // This shouldn't happen in the live pipeline (upsertRepo runs before
  // scoring) but the inspector takes a different path.
  if (!existing) return baseline;
  const repoId = existing.id;

  let cloned: Awaited<ReturnType<typeof shallowClone>> | null = null;
  try {
    cloned = await shallowClone(owner, name, { token: opts.token });
    const indexId = await ensureRepoIndex(repoId, cloned.path, { readmeSha: safety.readmeSha });
    const { excerpts } = await retrieveSourceExcerpts(
      indexId,
      { outcome: attribution.outcome, matchedTerm: attribution.matchedTerm },
      project.techSummary,
    );
    if (excerpts.length === 0) return baseline;
    const verified = await scoreTargetedCandidate(safety, project, attribution, {
      sourceExcerpts: excerpts,
      forceApproach: opts.forceApproach,
    });
    return verified ?? baseline;
  } catch (err) {
    // Verification failure should never demote the baseline. Log and fall back.
    console.warn(`[source-verify] ${owner}/${name} → ${project.slug}: ${(err as Error).message}`);
    return baseline;
  } finally {
    if (cloned) await cloned.cleanup();
  }
}
