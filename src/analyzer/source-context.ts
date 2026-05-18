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

import { buildIndex, findFreshIndex, searchIndex, type SearchHit } from "../lib/repo-index";

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
  const merged = new Map<number, SearchHit>();
  for (const q of queries) {
    const hits = await searchIndex(indexId, q, perQueryTopK);
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
