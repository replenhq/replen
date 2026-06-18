// Library-vs-hype classifier. Today's GitHub trending is dominated by viral
// AI-hype repos (proofs-of-concept, "skills" collections, personal experiments)
// that aren't libraries you'd adopt. Metadata can't reliably tell Scrapling (a
// real library) from claw-code (a 200k-star viral experiment) — but a cheap LLM
// pass can. This classifies catalogue repos so we keep only the adoptable ones.

import { chatCompletion, triageModel } from "../analyzer/llm";
import { modalityFromTopics, coerceModalities, type Modality } from "../projects/modality";

export type RepoKind = "library" | "framework" | "app" | "experiment" | "content" | "unknown";

export type RepoClassification = { kind: RepoKind; modality: Modality[]; summary: string };

// Kinds worth keeping in the catalogue (things you'd actually adopt/use).
export const KEEP_KINDS = new Set<RepoKind>(["library", "framework", "app"]);
// Kinds that get the recency/"rising" treatment (a fresh dependency is the win;
// a fresh app is more likely a competitor than something you adopt).
export const RISING_KINDS = new Set<RepoKind>(["library", "framework"]);

const SYSTEM = `You classify GitHub repos for a catalogue of REUSABLE developer libraries.
For each numbered repo, decide what it fundamentally IS:
- "library": reusable code you import or depend on (a package — e.g. requests, opencv, drizzle-orm, scrapling).
- "framework": an opinionated framework you build applications on (e.g. next.js, django, fastapi).
- "app": a deployable end-user application or self-hosted tool you run, not import.
- "experiment": a viral demo, proof-of-concept, hackathon or personal project, or AI-hype repo that is NOT meant to be adopted as a dependency — even if it has many stars.
- "content": curated lists, tutorials, courses, prompts, "skills", roadmaps, books, learning resources — not code to adopt.

Be strict: popularity is NOT evidence of being a library. A viral demo or personal
experiment is "experiment", not "library". A collection of prompts/skills is "content".

Also tag the DATA MODALITY each repo operates on — the kind of data/signal — as an
array from EXACTLY this set (use [] for infra/generic libs with no specific data type):
["image","video","timeseries","tabular","text","audio","geospatial","graph","3d","code","network"].
Examples: an image anomaly-detection lib → ["image"]; a telemetry/time-series tool →
["timeseries"]; a recommender → ["tabular"]; a satellite-imagery segmenter → ["image","geospatial"];
an NLP/LLM lib → ["text"]; a web framework or ORM → [].

Also write "s": ONE concise sentence saying what the repo DOES as a reusable capability — the
data it operates on + the specific task — grounded and factual, no marketing. This is the
candidate-side analog of a project capability descriptor, so it must read like one: e.g.
"TLS-fingerprint-rotating HTTP client that defeats Cloudflare bot detection for scraping", or
"on-device OCR + receipt-field parsing over phone-camera images". Keep it under ~25 words.

Output JSON only: {"v": {"0":{"k":"library","m":["image"],"s":"…"}, "1":{"k":"experiment","m":[],"s":"…"}, ...}}
with an entry for EVERY index. "k" is the kind, "m" is the modality array, "s" is the capability sentence.`;

/**
 * Classify a batch of repos into {kind, modality}, parallel-indexed to the
 * input. Modality is the UNION of a deterministic topic map (always applied,
 * free) and the LLM's verdict — so even on LLM failure we still get topic-
 * derived modality. Kind defaults to "unknown" (callers keep unknowns).
 */
export async function classifyRepos(
  repos: Array<{ fullName: string; description: string | null; topics: string[]; stars: number | null }>,
): Promise<RepoClassification[]> {
  if (repos.length === 0) return [];
  // Deterministic modality from topics first — this never fails.
  const out: RepoClassification[] = repos.map((r) => ({ kind: "unknown" as RepoKind, modality: modalityFromTopics(r.topics), summary: "" }));
  const list = repos
    .map((r, i) => `${i}. ${r.fullName} (${r.stars ?? "?"}★) — ${(r.description ?? "").replace(/\s+/g, " ").slice(0, 160)} [${r.topics.slice(0, 6).join(", ")}]`)
    .join("\n");
  try {
    const res = await chatCompletion(
      {
        model: triageModel(),
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: list }],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 2200,
      },
      { timeoutMs: 60_000, retries: 1 },
    );
    const text = res.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as { v?: Record<string, { k?: string; m?: unknown; s?: unknown } | string> };
    const v = parsed.v ?? {};
    for (const [key, val] of Object.entries(v)) {
      const idx = parseInt(key, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= out.length) continue;
      // Tolerate both the new {k, m} shape and a bare kind string.
      const kindRaw = typeof val === "string" ? val : String(val?.k ?? "");
      const kind = kindRaw.toLowerCase();
      if (kind === "library" || kind === "framework" || kind === "app" || kind === "experiment" || kind === "content") {
        out[idx].kind = kind;
      }
      if (typeof val === "object" && val) {
        const llmMods = coerceModalities(val.m);
        if (llmMods.length) {
          const merged = new Set<Modality>([...out[idx].modality, ...llmMods]);
          out[idx].modality = [...merged];
        }
        if (typeof val.s === "string" && val.s.trim()) out[idx].summary = val.s.trim().slice(0, 300);
      }
    }
  } catch (e) {
    console.warn(`[classify] batch failed: ${(e as Error).message}`);
  }
  return out;
}
