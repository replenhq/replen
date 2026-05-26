// Server-side semantic embeddings via OpenAI text-embedding-3-small.
//
// Why this exists: skill-tier shortlisting used to be bag-of-tags
// intersection — produced noise dominated by high-star generic
// trending repos that share one topic with the project. Semantic
// embeddings give us a real "is this candidate actually about what
// this project is about?" signal at ~$0.0001 per query (1000× cheaper
// than per-candidate LLM scoring) and ~80% of the quality.
//
// We use Replen's own OPENAI_API_KEY here — the user never sees this.
// The whole point of skill-tier is "no user-side API keys"; pushing
// embedding cost onto the user would re-introduce the friction we
// just removed.
//
// Storage shape: 1536-dim float vectors serialised as JSON
// (`number[]`) in the `embedding` text column on both
// `candidates` and `project_profiles`. SQLite doesn't have a native
// vector type and per-query cosine similarity over ~hundreds of
// candidates is microseconds in JS, so we don't need a vector
// database for this scale.

import { createHash } from "node:crypto";

const MODEL = "text-embedding-3-small";
const DIMS = 1536;
// OpenAI's embeddings endpoint accepts batches; we batch on the
// caller side for efficiency. ~$0.02/1M tokens, so even a batch of
// 100 candidates × ~100 tokens each is fractions of a cent.
const ENDPOINT = "https://api.openai.com/v1/embeddings";
const TIMEOUT_MS = 30_000;
const MAX_INPUT_LENGTH = 8000; // OpenAI's per-input token limit, char-approximated

export type EmbeddingResult = {
  vector: number[];
  contentHash: string;
  model: string;
  generatedAt: Date;
};

/**
 * Generate an embedding for one piece of text. Returns null if the
 * API call fails (caller decides whether to retry, fall back, or
 * leave the embedding column null and rely on lazy backfill).
 *
 * The returned vector is L2-normalised by OpenAI, so cosine
 * similarity simplifies to a dot product — fast.
 */
export async function embed(text: string): Promise<EmbeddingResult | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_EMBEDDING_KEY;
  if (!apiKey) {
    console.warn("[embeddings] OPENAI_API_KEY not set; embedding skipped");
    return null;
  }
  const trimmed = truncateToLimit(text);
  if (!trimmed) return null;

  const contentHash = sha256(trimmed);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, input: trimmed }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[embeddings] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vector = json.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== DIMS) {
      console.warn(`[embeddings] unexpected response shape; length=${vector?.length}`);
      return null;
    }
    return { vector, contentHash, model: MODEL, generatedAt: new Date() };
  } catch (e) {
    console.warn(`[embeddings] request failed:`, (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Batch-embed up to N pieces of text in one HTTP round-trip. Returns
 * an array of results (parallel-indexed to the input); slots are null
 * for inputs that couldn't be embedded.
 *
 * Use this when populating embeddings for many candidates at once
 * (e.g., after a fetcher run). Cuts API round-trips significantly.
 */
export async function embedBatch(texts: string[]): Promise<Array<EmbeddingResult | null>> {
  if (texts.length === 0) return [];
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_EMBEDDING_KEY;
  if (!apiKey) {
    console.warn("[embeddings] OPENAI_API_KEY not set; batch embedding skipped");
    return texts.map(() => null);
  }
  const trimmed = texts.map(truncateToLimit);
  const hashes = trimmed.map((t) => (t ? sha256(t) : ""));
  // OpenAI accepts an array `input` and returns parallel `data`. Empty
  // strings would 400 — substitute with a sentinel and null out the
  // result for those positions afterward.
  const safeInputs = trimmed.map((t) => t || "_");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, input: safeInputs }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[embeddings] batch HTTP ${res.status}: ${body.slice(0, 200)}`);
      return texts.map(() => null);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const data = json.data ?? [];
    const out: Array<EmbeddingResult | null> = trimmed.map(() => null);
    const now = new Date();
    for (const item of data) {
      const idx = typeof item.index === "number" ? item.index : -1;
      if (idx < 0 || idx >= out.length) continue;
      if (!trimmed[idx]) continue; // we substituted "_", drop the result
      const v = item.embedding;
      if (!Array.isArray(v) || v.length !== DIMS) continue;
      out[idx] = { vector: v, contentHash: hashes[idx], model: MODEL, generatedAt: now };
    }
    return out;
  } catch (e) {
    console.warn(`[embeddings] batch request failed:`, (e as Error).message);
    return texts.map(() => null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cosine similarity between two L2-normalised vectors (which is what
 * OpenAI returns). For normalised vectors, cosine = dot product, so
 * we skip the (otherwise required) magnitude division.
 *
 * Returns NaN if the vectors are wrong-shaped — caller should treat
 * NaN as "no signal" rather than as a comparable score.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return NaN;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Pull an embedding vector out of the JSON-serialised form stored in
 * the DB. Returns null for malformed / missing data; callers should
 * treat null as "no embedding yet" and either skip ranking or fall
 * back to the previous tag-based ordering.
 */
export function parseStoredEmbedding(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== DIMS) return null;
    if (!arr.every((n) => typeof n === "number")) return null;
    return arr;
  } catch {
    return null;
  }
}

export function serialiseEmbedding(vector: number[]): string {
  return JSON.stringify(vector);
}

/**
 * Compose the canonical text to embed for a candidate. Order matters
 * (more discriminating signals first; OpenAI weights early tokens
 * more heavily): title → description → topics → shape.
 *
 * Caller passes whatever fields it has; absent fields are skipped.
 */
export function candidateEmbeddingText(input: {
  title?: string | null;
  description?: string | null;
  topics?: string[] | null;
  repoShape?: string | null;
  primaryLanguage?: string | null;
}): string {
  const parts: string[] = [];
  if (input.title) parts.push(input.title.trim());
  if (input.description) parts.push(input.description.trim());
  if (input.topics && input.topics.length > 0) {
    parts.push(`Topics: ${input.topics.join(", ")}`);
  }
  if (input.primaryLanguage) parts.push(`Language: ${input.primaryLanguage}`);
  if (input.repoShape) parts.push(`Kind: ${input.repoShape}`);
  return parts.join(". ");
}

/**
 * Compose the canonical text to embed for a project. Drives the
 * "what is this project about" query vector — kept verbose because
 * project profiles change rarely (cached for the project's lifetime
 * by content hash) and richer text gives sharper semantic matching.
 */
export function projectEmbeddingText(input: {
  name?: string | null;
  oneLiner?: string | null;
  niche?: string | null;
  outcomeGoals?: string[] | null;
  tags?: string[] | null;
  primaryLanguage?: string | null;
}): string {
  const parts: string[] = [];
  if (input.name) parts.push(`Project: ${input.name.trim()}`);
  if (input.oneLiner) parts.push(input.oneLiner.trim());
  if (input.niche) parts.push(`Domain: ${input.niche.trim()}`);
  if (input.outcomeGoals && input.outcomeGoals.length > 0) {
    parts.push(`Outcome goals: ${input.outcomeGoals.join("; ")}`);
  }
  if (input.tags && input.tags.length > 0) {
    parts.push(`Stack: ${input.tags.join(", ")}`);
  }
  if (input.primaryLanguage) parts.push(`Primary language: ${input.primaryLanguage}`);
  return parts.join(". ");
}

function truncateToLimit(text: string): string {
  if (!text) return "";
  if (text.length <= MAX_INPUT_LENGTH) return text;
  return text.slice(0, MAX_INPUT_LENGTH);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
