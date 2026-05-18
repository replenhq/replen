// Index builder + persistence + rehydration for the candidate-OSS indexer.
//
// Three operations:
//   - buildIndex(repoId, path) : walk → chunk → tokenise → BM25 → write to SQLite
//   - loadIndex(repoId)        : rehydrate the TermIndex from SQLite
//   - searchIndex(repoId, q)   : tokenise the query, score against the loaded
//                                 index, fetch chunk content for the top-k
//
// The whole indexer assumes one repo at a time. There's no shared in-memory
// cache across requests; rehydration is cheap (it's an ORDER BY index_id
// scan over a few hundred thousand rows for a typical candidate repo) and
// shipping a cache invites consistency bugs.

import { readFile } from "node:fs/promises";
import { db, schema } from "@/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";

import { walkRepo, type WalkOpts } from "./walker";
import { chunkFile, detectLanguage } from "./chunker";
import { tokenize } from "./tokens";
import { buildTermIndex, loadTermIndex, scoreBM25, type TermIndex } from "./bm25";

// Bump when the chunking algorithm or token rules change. Any saved index
// at a different version is treated as stale and rebuilt on next use.
export const INDEX_VERSION = "v1.0";

export type SearchHit = {
  chunkId: number;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string | null;
  content: string;
  score: number;
};

/**
 * Build (or rebuild) the BM25 index for `repoId` from a local directory
 * `path` (typically a freshly-cloned shallow checkout of the OSS repo).
 *
 * Idempotent: an existing index at INDEX_VERSION for this repo is deleted
 * first so the new one replaces it cleanly. Returns the index row id.
 */
export async function buildIndex(
  repoId: number,
  path: string,
  opts: { readmeSha?: string | null; walkOpts?: WalkOpts } = {},
): Promise<{ indexId: number; chunkCount: number; byteCount: number; totalTokens: number }> {
  // Walk + chunk + tokenise. We collect everything in memory first because
  // BM25 needs the full corpus (avgdl, df) to compute the per-doc lengths
  // and term frequencies. For typical candidate repos (~few thousand chunks)
  // memory is bounded and well under hundreds of MB.
  type StagedChunk = {
    filePath: string;
    startLine: number;
    endLine: number;
    language: string | null;
    content: string;
    tokens: string[];
  };
  const staged: StagedChunk[] = [];
  let byteCount = 0;
  for await (const file of walkRepo(path, opts.walkOpts)) {
    let source: string;
    try {
      source = await readFile(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    byteCount += Buffer.byteLength(source, "utf8");
    const language = detectLanguage(file.extension);
    const chunks = chunkFile(file.relativePath, source, language);
    for (const c of chunks) {
      staged.push({
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        language: c.language,
        content: c.content,
        tokens: tokenize(c.content),
      });
    }
  }

  // Drop any existing index for this repo at this version. Cascade deletes
  // chunks + terms in one go.
  await db
    .delete(schema.repoIndexes)
    .where(and(eq(schema.repoIndexes.repoId, repoId), eq(schema.repoIndexes.indexVersion, INDEX_VERSION)));

  const totalTokens = staged.reduce((acc, s) => acc + s.tokens.length, 0);

  const indexRow = await db
    .insert(schema.repoIndexes)
    .values({
      repoId,
      readmeSha: opts.readmeSha ?? null,
      builtAt: new Date(),
      chunkCount: staged.length,
      byteCount,
      indexVersion: INDEX_VERSION,
      totalTokens,
    })
    .returning()
    .get();
  if (!indexRow) throw new Error("failed to insert repo_indexes row");
  const indexId = indexRow.id;

  if (staged.length === 0) {
    // Empty repo (no indexable files). Index row is still useful as a
    // tombstone — it prevents repeated rebuild attempts on a repo that
    // genuinely has nothing to index.
    return { indexId, chunkCount: 0, byteCount, totalTokens: 0 };
  }

  // Batch-insert chunks, capturing the new IDs so we can wire up the term
  // postings against them. Drizzle's SQLite driver doesn't return rows from
  // a multi-row insert reliably, so we insert one at a time. Acceptable on
  // ~few-thousand-chunk corpora; revisit if this becomes a bottleneck.
  const termRows: { indexId: number; term: string; chunkId: number; freq: number }[] = [];
  for (const s of staged) {
    const inserted = await db
      .insert(schema.repoChunks)
      .values({
        indexId,
        filePath: s.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
        language: s.language,
        content: s.content,
        docLength: s.tokens.length,
      })
      .returning({ id: schema.repoChunks.id })
      .get();
    if (!inserted) continue;
    const chunkId = inserted.id;
    const termFreq = new Map<string, number>();
    for (const t of s.tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    for (const [term, freq] of termFreq) {
      termRows.push({ indexId, term, chunkId, freq });
    }
  }

  // Chunked insert for terms. SQLite has a default 999-variable limit per
  // statement; 4 columns × ~250 rows per batch keeps us comfortably under.
  const BATCH = 250;
  for (let i = 0; i < termRows.length; i += BATCH) {
    await db.insert(schema.repoChunkTerms).values(termRows.slice(i, i + BATCH));
  }

  return { indexId, chunkCount: staged.length, byteCount, totalTokens };
}

/**
 * Find an existing index row for this repo if it exists and is up-to-date
 * (matching INDEX_VERSION; optionally matching the readme_sha if a fresh
 * one is given). Returns null when no usable index exists — caller should
 * rebuild.
 */
export async function findFreshIndex(
  repoId: number,
  currentReadmeSha?: string | null,
): Promise<{ indexId: number; readmeSha: string | null; builtAt: Date } | null> {
  const row = await db
    .select()
    .from(schema.repoIndexes)
    .where(and(eq(schema.repoIndexes.repoId, repoId), eq(schema.repoIndexes.indexVersion, INDEX_VERSION)))
    .get();
  if (!row) return null;
  if (currentReadmeSha != null && row.readmeSha !== currentReadmeSha) return null;
  return { indexId: row.id, readmeSha: row.readmeSha, builtAt: row.builtAt };
}

/**
 * Rehydrate a TermIndex from SQLite for a known indexId. Used by search.
 */
export async function loadIndex(indexId: number): Promise<TermIndex> {
  const indexRow = await db
    .select({ totalTokens: schema.repoIndexes.totalTokens, chunkCount: schema.repoIndexes.chunkCount })
    .from(schema.repoIndexes)
    .where(eq(schema.repoIndexes.id, indexId))
    .get();
  if (!indexRow) throw new Error(`indexId ${indexId} not found`);

  const docLengthRows = await db
    .select({ chunkId: schema.repoChunks.id, docLength: schema.repoChunks.docLength })
    .from(schema.repoChunks)
    .where(eq(schema.repoChunks.indexId, indexId));

  const termRows = await db
    .select({
      term: schema.repoChunkTerms.term,
      chunkId: schema.repoChunkTerms.chunkId,
      freq: schema.repoChunkTerms.freq,
    })
    .from(schema.repoChunkTerms)
    .where(eq(schema.repoChunkTerms.indexId, indexId));

  return loadTermIndex(termRows, docLengthRows, indexRow.totalTokens, indexRow.chunkCount);
}

/**
 * Tokenise the query, score against the loaded index, and return the top-k
 * hits with chunk content materialised. The two rerank passes (path penalty,
 * multi-chunk-file boost) are intentionally cheap; tuning happens later
 * based on how Stage 4 verification calls actually look.
 */
export async function searchIndex(
  indexId: number,
  query: string,
  topK: number = 10,
): Promise<SearchHit[]> {
  const index = await loadIndex(indexId);
  return searchLoadedIndex(index, query, topK);
}

/**
 * Same as searchIndex but takes an already-rehydrated TermIndex. Use this
 * when running multiple queries against the same index — loadIndex pulls
 * every term posting out of SQLite, so doing it once and reusing the result
 * across queries is materially faster (the dominant cost for multi-query
 * workflows like Stage 4 verification).
 */
export async function searchLoadedIndex(
  index: TermIndex,
  query: string,
  topK: number = 10,
): Promise<SearchHit[]> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Pull top-k * 3 candidates so reranking has headroom; tuning factor is
  // arbitrary — generous enough to let rerank shuffle without losing the
  // best hit, tight enough that we don't fetch hundreds of chunk rows.
  const scored = scoreBM25(index, queryTokens, topK * 3);
  if (scored.length === 0) return [];

  const chunkRows = await db
    .select()
    .from(schema.repoChunks)
    .where(inArray(schema.repoChunks.id, scored.map((s) => s.chunkId)));
  const byId = new Map<number, typeof chunkRows[number]>();
  for (const c of chunkRows) byId.set(c.id, c);

  // Multi-chunk-file boost: when several hits live in the same file, the
  // file as a whole is probably relevant; bump each of its hits a little
  // so they cluster at the top instead of getting interleaved with weaker
  // single-hit files. +10% per extra chunk in the same file, capped.
  const fileHitCount = new Map<string, number>();
  for (const s of scored) {
    const path = byId.get(s.chunkId)?.filePath;
    if (path) fileHitCount.set(path, (fileHitCount.get(path) ?? 0) + 1);
  }

  // Path penalty: chunks in test/example/vendor paths lose 20%. They're
  // usually less authoritative about the repo's API surface than chunks in
  // src/ or lib/. The penalty list is conservative — we add to it as we
  // find paths the LLM consistently treats as noise.
  const penalisedPathPattern = /(^|\/)(test|tests|__tests__|spec|examples|example|vendor|third_party|node_modules|fixtures|docs)(\/|$)/;

  // Identifier-exact-match boost: when a query token appears as an
  // independent identifier in the chunk content (whole-word match, not just
  // substring), give a +25% bump. This makes verification queries like
  // `Sandbox.builder` find the chunks that actually define that symbol.
  const queryTokensLowerSet = new Set(queryTokens);
  const exactWordRe = new RegExp(`\\b(${queryTokens.map(escapeRe).join("|")})\\b`, "i");

  const reranked: SearchHit[] = [];
  for (const s of scored) {
    const c = byId.get(s.chunkId);
    if (!c) continue;
    let score = s.score;
    const hits = fileHitCount.get(c.filePath) ?? 1;
    if (hits > 1) score *= 1 + Math.min(0.4, 0.1 * (hits - 1));
    if (penalisedPathPattern.test(c.filePath)) score *= 0.8;
    if (queryTokensLowerSet.size > 0 && exactWordRe.test(c.content)) score *= 1.25;
    reranked.push({
      chunkId: c.id,
      filePath: c.filePath,
      startLine: c.startLine,
      endLine: c.endLine,
      language: c.language,
      content: c.content,
      score,
    });
  }

  reranked.sort((a, b) => b.score - a.score);
  return reranked.slice(0, topK);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Drop an index entirely. Used by the aging cron (when implemented) to
 * reclaim space for repos that haven't surfaced in a long time.
 */
export async function deleteIndex(indexId: number): Promise<void> {
  await db.delete(schema.repoIndexes).where(eq(schema.repoIndexes.id, indexId));
}

/**
 * Convenience: total bytes stored by all indexes for a given repo. Used by
 * the inspector + future aging policies. Not on the hot path.
 */
export async function indexStorageBytes(repoId: number): Promise<number> {
  const row = await db
    .select({ s: sql<number>`COALESCE(SUM(${schema.repoIndexes.byteCount}), 0)` })
    .from(schema.repoIndexes)
    .where(eq(schema.repoIndexes.repoId, repoId))
    .get();
  return Number(row?.s ?? 0);
}
