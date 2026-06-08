// Library-vs-hype classifier. Today's GitHub trending is dominated by viral
// AI-hype repos (proofs-of-concept, "skills" collections, personal experiments)
// that aren't libraries you'd adopt. Metadata can't reliably tell Scrapling (a
// real library) from claw-code (a 200k-star viral experiment) — but a cheap LLM
// pass can. This classifies catalogue repos so we keep only the adoptable ones.

import { chatCompletion, triageModel } from "../analyzer/llm";

export type RepoKind = "library" | "framework" | "app" | "experiment" | "content" | "unknown";

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

Output JSON only: {"v": {"0":"library","1":"experiment", ...}} with a verdict for EVERY index.`;

/**
 * Classify a batch of repos. Returns kinds parallel-indexed to the input
 * (defaults to "unknown" for anything the model didn't return). Safe on
 * failure — returns all "unknown" so callers can fall back to keeping them.
 */
export async function classifyRepos(
  repos: Array<{ fullName: string; description: string | null; topics: string[]; stars: number | null }>,
): Promise<RepoKind[]> {
  if (repos.length === 0) return [];
  const out: RepoKind[] = repos.map(() => "unknown");
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
        max_tokens: 1800,
      },
      { timeoutMs: 60_000, retries: 1 },
    );
    const text = res.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as { v?: Record<string, string> };
    const v = parsed.v ?? {};
    for (const [k, val] of Object.entries(v)) {
      const idx = parseInt(k, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= out.length) continue;
      const kind = String(val).toLowerCase();
      if (kind === "library" || kind === "framework" || kind === "app" || kind === "experiment" || kind === "content") {
        out[idx] = kind;
      }
    }
  } catch (e) {
    console.warn(`[classify] batch failed: ${(e as Error).message}`);
  }
  return out;
}
