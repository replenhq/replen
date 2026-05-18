// Okapi BM25 over a candidate-OSS repo's chunks.
//
// Standard BM25 score for one query term and one chunk:
//
//     score(term, chunk) = idf(term) · ((tf · (k1 + 1)) / (tf + k1 · (1 - b + b · dl / avgdl)))
//
// where:
//     idf(term)   = ln((N - df + 0.5) / (df + 0.5) + 1)   (Lucene-style, always positive)
//     tf          = how often `term` appears in `chunk` (raw frequency)
//     dl          = number of tokens in `chunk` (doc length)
//     avgdl       = mean doc length across the corpus
//     k1          = 1.5     (term-frequency saturation; 1.2-2.0 is typical)
//     b           = 0.75    (length normalisation strength; standard)
//     N           = total number of chunks (docs)
//     df          = number of chunks containing `term`
//
// Score for a multi-term query: sum the per-term scores. Chunks that match
// more terms or have higher per-term tf rank higher. Long chunks get a mild
// penalty so a 1500-byte chunk doesn't always beat a 200-byte chunk just
// because it accidentally contains more vocabulary.
//
// This implementation works on a pre-built `TermIndex` structure that maps
// `term -> Map<chunkId, freq>`. Both build and rehydration go through the
// same constructor, so a freshly-indexed corpus and a corpus loaded from
// SQLite use the exact same query path.

const K1 = 1.5;
const B = 0.75;

export type TermIndex = {
  // term -> chunkId -> raw frequency
  postings: Map<string, Map<number, number>>;
  // chunkId -> doc length (token count)
  docLengths: Map<number, number>;
  // Average doc length, pre-computed.
  avgDocLength: number;
  // Total number of chunks (N in the BM25 formula).
  docCount: number;
};

/**
 * Build a TermIndex from an in-memory corpus. The input is a list of
 * (chunkId, tokens) pairs — caller is responsible for assigning chunk ids
 * (either pre-existing from SQLite or fresh integers).
 */
export function buildTermIndex(docs: Array<{ chunkId: number; tokens: string[] }>): TermIndex {
  const postings = new Map<string, Map<number, number>>();
  const docLengths = new Map<number, number>();
  let totalLength = 0;

  for (const { chunkId, tokens } of docs) {
    docLengths.set(chunkId, tokens.length);
    totalLength += tokens.length;
    // Count per-doc term frequencies.
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    for (const [term, f] of freq) {
      let chunkMap = postings.get(term);
      if (!chunkMap) {
        chunkMap = new Map();
        postings.set(term, chunkMap);
      }
      chunkMap.set(chunkId, f);
    }
  }

  return {
    postings,
    docLengths,
    avgDocLength: docs.length > 0 ? totalLength / docs.length : 0,
    docCount: docs.length,
  };
}

/**
 * Rehydrate a TermIndex from SQLite-loaded rows. The caller has already
 * fetched the postings (one row per (term, chunkId, freq)) and the doc
 * lengths; this just shapes them into the structures BM25 scoring needs.
 */
export function loadTermIndex(
  rows: Array<{ term: string; chunkId: number; freq: number }>,
  docLengthRows: Array<{ chunkId: number; docLength: number }>,
  totalTokens: number,
  docCount: number,
): TermIndex {
  const postings = new Map<string, Map<number, number>>();
  for (const r of rows) {
    let chunkMap = postings.get(r.term);
    if (!chunkMap) {
      chunkMap = new Map();
      postings.set(r.term, chunkMap);
    }
    chunkMap.set(r.chunkId, r.freq);
  }
  const docLengths = new Map<number, number>();
  for (const d of docLengthRows) docLengths.set(d.chunkId, d.docLength);
  return {
    postings,
    docLengths,
    avgDocLength: docCount > 0 ? totalTokens / docCount : 0,
    docCount,
  };
}

export type ScoredChunk = { chunkId: number; score: number };

/**
 * Score `queryTokens` against the index, returning the top-k chunks by
 * descending BM25 score. Chunks with zero matching tokens are excluded.
 */
export function scoreBM25(index: TermIndex, queryTokens: string[], topK: number): ScoredChunk[] {
  if (queryTokens.length === 0 || index.docCount === 0) return [];

  // Aggregate per-chunk scores across all query terms. Dedupe query tokens
  // so a query like "user user user" doesn't count the same idf three times.
  const seen = new Set<string>();
  const scores = new Map<number, number>();

  for (const term of queryTokens) {
    if (seen.has(term)) continue;
    seen.add(term);
    const postings = index.postings.get(term);
    if (!postings) continue;
    const df = postings.size;
    const idf = Math.log(((index.docCount - df + 0.5) / (df + 0.5)) + 1);

    for (const [chunkId, tf] of postings) {
      const dl = index.docLengths.get(chunkId) ?? 0;
      const denom = tf + K1 * (1 - B + (B * dl) / (index.avgDocLength || 1));
      const numer = tf * (K1 + 1);
      const contribution = idf * (numer / denom);
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + contribution);
    }
  }

  // Top-k by descending score. For small topK this is just a sort; for
  // very large corpora a heap would be faster, but our largest corpus is
  // a few thousand chunks per repo so simple sort wins on simplicity.
  const all = Array.from(scores, ([chunkId, score]) => ({ chunkId, score }));
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, topK);
}
