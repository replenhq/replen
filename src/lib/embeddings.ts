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

// ── Embedding health (resilience) ────────────────────────────────────────────
// Embedding failures used to be swallowed (return null), so an out-of-quota key
// degraded the whole matcher SILENTLY — new candidates/facets just never got
// vectors. We now keep a sticky record of the last failure (esp. quota
// exhaustion) so /api/healthz + replen_status can surface it loudly. Cleared on
// the next successful embed.
type EmbedHealth = { ok: boolean; at: string; status: number | null; quotaExhausted: boolean; message: string };
let lastEmbedFailure: EmbedHealth | null = null;
let lastEmbedSuccessAt: string | null = null;
export function getEmbeddingHealth(): { ok: boolean; lastSuccessAt: string | null; lastFailure: EmbedHealth | null } {
  return { ok: lastEmbedFailure === null, lastSuccessAt: lastEmbedSuccessAt, lastFailure: lastEmbedFailure };
}
function noteEmbedSuccess(): void { lastEmbedFailure = null; lastEmbedSuccessAt = new Date().toISOString(); }
function noteEmbedFailure(status: number | null, body: string): void {
  const quota = status === 429 || /insufficient_quota|exceeded your current quota|billing/i.test(body);
  lastEmbedFailure = {
    ok: false, at: new Date().toISOString(), status, quotaExhausted: quota,
    message: quota
      ? "OpenAI embedding key is OUT OF QUOTA — top up billing at platform.openai.com. New candidates/facets/catalogue entries are NOT being embedded; matching runs on stale vectors only."
      : `embedding request failed (status ${status ?? "network"}): ${body.slice(0, 160)}`,
  };
  if (quota) console.error(`[embeddings] QUOTA EXHAUSTED — ${lastEmbedFailure.message}`);
}

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
      noteEmbedFailure(res.status, body);
      return null;
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vector = json.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== DIMS) {
      console.warn(`[embeddings] unexpected response shape; length=${vector?.length}`);
      return null;
    }
    noteEmbedSuccess();
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
      noteEmbedFailure(res.status, body);
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
    if (data.length > 0) noteEmbedSuccess();
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

// L2-normalize a vector to unit length. Use this on any vector you BUILD by
// summing/averaging stored embeddings before passing it to cosineSimilarity:
// cosineSimilarity is a bare dot product (correct only because individual
// stored OpenAI vectors are already unit-length), so the mean of unit vectors
// — which has magnitude < 1 — would otherwise yield a deflated, non-cosine
// score. Returns the input unchanged if it's zero/degenerate.
export function normalizeVec(v: number[]): number[] {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  if (!Number.isFinite(mag) || mag === 0) return v;
  return v.map((x) => x / mag);
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
  readmeHead?: string | null;
}): string {
  const parts: string[] = [];
  if (input.title) parts.push(input.title.trim());
  if (input.description) parts.push(input.description.trim());
  if (input.topics && input.topics.length > 0) {
    parts.push(`Topics: ${input.topics.join(", ")}`);
  }
  if (input.primaryLanguage) parts.push(`Language: ${input.primaryLanguage}`);
  if (input.readmeHead) parts.push(input.readmeHead);
  if (input.repoShape) parts.push(`Kind: ${input.repoShape}`);
  return parts.join(". ");
}

// Strip a README down to the prose that actually describes the project:
// badges, HTML, link targets, and code fences are noise to the embedding.
export function cleanReadmeHead(md: string | null | undefined, maxChars = 1500): string | null {
  if (!md) return null;
  const text = md
    .replace(/```[\s\S]*?```/g, " ")          // code fences
    .replace(/<!--[\s\S]*?-->/g, " ")          // comments
    .replace(/<[^>]+>/g, " ")                  // html tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")     // images/badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // links → anchor text
    .replace(/^#{1,6}\s*/gm, "")               // heading markers
    .replace(/[*_`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 40) return null; // badge-wall READMEs carry no prose
  return text.slice(0, maxChars);
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

// ── Faceted matching (Phase 1) ──────────────────────────────────────────────
// A project's capabilities are embedded SEPARATELY (one vector each) so a
// candidate can match the project's strongest single capability instead of its
// blended centroid. A computer-vision library scores ~0 against "defense
// intelligence app" but high against the "computer vision" facet — the centroid
// can't see it, a facet can.

// `repo` is set only for facets borrowed from a SIBLING repo in the same
// multi-repo product (for attribution — "this match is for your acme-cv").
// Undefined for the scoped repo's own facets.
export type FacetEmbedding = { label: string; vec: number[]; repo?: string; modality?: import("../projects/modality").Modality[]; provenance?: import("../projects/modality").Provenance; paths?: string[] };
export type StoredFacetEmbeddings = { hash: string; facets: FacetEmbedding[] };

// Capability labels too generic to be useful probes — they'd match almost any
// repo and reintroduce the firehose. Dropped before embedding. Kept minimal:
// the summarizer already curates specific noun phrases, this just trims the
// occasional catch-all.
const GENERIC_FACETS = new Set([
  "api", "apis", "web", "webapp", "app", "application", "ui", "ux", "frontend",
  "front-end", "backend", "back-end", "fullstack", "full-stack", "database",
  "data", "cli", "tooling", "testing", "logging", "auth", "authentication",
  "devops", "ci/cd", "infrastructure", "deployment", "monitoring", "analytics",
]);

/**
 * Normalise + dedupe a project's capability labels into the facets worth
 * embedding. Drops blanks, too-short, and over-generic labels, lowercases for
 * dedupe but keeps the first-seen original casing for display, and caps the
 * count so a sprawling capability list doesn't balloon storage / API cost.
 */
export function selectFacetLabels(labels: Array<string | null | undefined>, cap = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    const key = label.toLowerCase();
    if (label.length < 4) continue; // "ml", "ai" etc. — too ambiguous to probe
    if (GENERIC_FACETS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Text to embed for a single capability facet. When a GROUNDED descriptor is
 * available (the in-session agent or summarizer wrote "rule-based anomaly
 * detection over drone telemetry time-series — link-loss, GPS-drop; no ML"), we
 * embed THAT — it's rich enough that cosine separates a telemetry capability
 * from an image-defect library. Without a descriptor we fall back to the bare
 * "Capability: <label>" anchor (legacy behaviour). Trimmed to the embed cap.
 */
export function facetEmbeddingText(label: string, descriptor?: string | null): string {
  const d = descriptor?.trim();
  if (d) return `Capability: ${label.trim()} — ${d}`.slice(0, 7000);
  return `Capability: ${label.trim()}`;
}

export function serialiseFacetEmbeddings(v: StoredFacetEmbeddings): string {
  return JSON.stringify(v);
}

/** Parse the stored facet-embeddings blob. Returns [] on missing/malformed. */
export function parseStoredFacetEmbeddings(raw: string | null | undefined): FacetEmbedding[] {
  if (!raw) return [];
  try {
    const o = JSON.parse(raw) as Partial<StoredFacetEmbeddings>;
    if (!o || !Array.isArray(o.facets)) return [];
    return o.facets.filter(
      (f): f is FacetEmbedding =>
        !!f &&
        typeof f.label === "string" &&
        Array.isArray(f.vec) &&
        f.vec.length === DIMS &&
        f.vec.every((n) => typeof n === "number"),
    );
  } catch {
    return [];
  }
}

/**
 * Hash of the facet label set + a version marker. Drives regeneration: when the
 * capability list changes (or we bump the scheme) the facet vectors rebuild.
 */
// "2" (Phase 3): facet set now includes raw doc-section vectors alongside the
// capability vectors. Bumping regenerates every project's facets to add them.
// "3" (grounded matching): capability facets embed a GROUNDED descriptor (+
// modality) rather than the bare label. Bumping regenerates every project's
// facets with the richer, modality-aware probes.
// "4" (provenance): each facet carries a provenance tag (grounded/extracted/
// inferred/ambiguous). Bumping regenerates so every facet is tagged.
export const FACET_SCHEME_VERSION = "4";
export function facetSetHash(labels: string[]): string {
  return sha256(`${FACET_SCHEME_VERSION}:${labels.map((l) => l.toLowerCase()).join("|")}`);
}

function truncateToLimit(text: string): string {
  if (!text) return "";
  if (text.length <= MAX_INPUT_LENGTH) return text;
  return text.slice(0, MAX_INPUT_LENGTH);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
