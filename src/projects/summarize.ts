// Stage 1: project understanding. Produces a structured summary from a
// project's README / CLAUDE.md / extra docs / techSummary. The summary is
// CONTEXT, not recommendations — gap identification (Stage 2) and matching
// (Stage 3+4) live elsewhere. See docs/stage-1-scope.md.

import { chatCompletion, triageModel } from "../analyzer/llm";

// Bump when the prompt or output schema changes. Bumping invalidates all
// existing summaries — they re-generate on next pipeline run.
export const PROMPT_VERSION = "1";

// Max age before we force-regenerate even if profileHash is unchanged.
// Catches the case where a user has changed direction in their head but
// hasn't pushed the doc edits yet. 3 days = sweet spot for AI-paced dev.
export const STALENESS_MS = 3 * 24 * 60 * 60 * 1000;

export type OutcomeGoal = {
  // Outcome (not a tool). E.g. "cleaner property scrapes with fewer Cloudflare flags".
  statement: string;
  // "user" = lifted verbatim from a doc the user wrote; "inferred" = LLM derived.
  source: "user" | "inferred";
  // Self-rated by the LLM. Stage-2 ignores `low` confidence inferred goals.
  // User-attributed goals are always "high".
  confidence: "high" | "medium" | "low";
};

export type CrossRepoDep = {
  direction: "consumes_from" | "feeds_into";
  // Path or owner/name reference as it appears in the docs.
  target: string;
  description: string;
};

export type LanguageHardConstraint = {
  // The capability that forces the language (e.g. "browser-runtime UI code").
  capability: string;
  // Allowed languages for that capability (e.g. ["ts", "js"]).
  allowedLanguages: string[];
};

export type ProjectSummary = {
  // Purpose: one sentence + 2-4 sentence elaboration. What this is for and who it's for.
  purpose: string;

  // 3-8 short noun phrases describing what the project DOES.
  // E.g. ["lead capture", "property browsing", "admin reporting"].
  keyCapabilities: string[];

  // Current implementation across functional areas. Keys are free-form (web,
  // scraping, data, charts, ...); values describe what's used. CONTEXT for
  // gap analysis, never a recommendation gate.
  currentTech: Record<string, string>;

  // The durable signal: what "better" means for this user.
  outcomeGoals: OutcomeGoal[];

  // From docs only (Stage 1). Auto-detection from imports is later increment.
  crossRepoDependencies: CrossRepoDep[];

  // Soft language signals. `hardConstraints` lists capabilities where the
  // runtime forces a language. Everything else is open — a Python tool can
  // serve a TS project via sidecar/pipeline.
  languageSignals: {
    hardConstraints: LanguageHardConstraint[];
    detected: string[];
  };

  // Metadata for the UI + debugging.
  generatedAt: string;
  sourceFiles: string[];
  llmModel: string;
  promptVersion: string;
};

export type SummarizeInput = {
  // Project's name and slug for context.
  name: string;
  slug: string;
  // The text inputs. README + CLAUDE.md + foldedExtraDocs come from the
  // existing loader; techSummary is the existing manifest digest.
  readmeMd: string | null;
  claudeMd: string | null;
  techSummary: string | null;
};

// Per-file char cap. The LLM only needs the top of each doc to grasp purpose
// and goals; the rest is implementation detail that we don't want to pay for.
const PER_FILE_CHARS = 8000;
const TOTAL_INPUT_CHARS = 24000;

const SYSTEM_PROMPT = `You extract a structured summary of a software project so that another
system (replen) can later find tools and libraries that would improve the
project's outcomes.

Your job is CONTEXT, not RECOMMENDATIONS:
- Describe what the project is for, what it does, what outcomes the author
  cares about, and any genuine technical constraints.
- Do NOT suggest tools, libraries, or improvements. That's a separate step.
- Do NOT identify gaps. That's a separate step.

Rules:
- If the user has stated an outcome verbatim in their docs (e.g. "I want
  faster scrapes"), lift it word-for-word. Mark it source="user", confidence="high".
- If you infer an outcome that wasn't stated, mark source="inferred" and
  self-rate confidence based on how clearly the docs support it.
- Language is a SOFT signal. Only list a hardConstraint when the runtime
  GENUINELY forces a language (e.g. "browser-runtime UI code must compile
  to JavaScript"). Backend services, data pipelines, scrapers, ML inference
  — none of these are hard language constraints.
- currentTech is descriptive context, never used as a filter for what to
  recommend. A TypeScript project can absolutely use a Python tool via a
  sidecar process.
- If the docs are sparse, the summary should be sparse. Don't pad. Don't
  invent capabilities or outcomes that aren't grounded in the input.

Output JSON only. No prose before or after. Schema:
{
  "purpose": "string (1 sentence + 2-4 sentence elaboration)",
  "keyCapabilities": ["3-8 short noun phrases"],
  "currentTech": { "web": "...", "scraping": "...", ... },
  "outcomeGoals": [
    { "statement": "...", "source": "user" | "inferred", "confidence": "high" | "medium" | "low" }
  ],
  "crossRepoDependencies": [
    { "direction": "consumes_from" | "feeds_into", "target": "...", "description": "..." }
  ],
  "languageSignals": {
    "hardConstraints": [{ "capability": "...", "allowedLanguages": ["..."] }],
    "detected": ["..."]
  }
}`;

function buildUserPrompt(input: SummarizeInput): string {
  const parts: string[] = [`Project: ${input.name} (slug: ${input.slug})`];
  const claudeMd = (input.claudeMd ?? "").slice(0, PER_FILE_CHARS);
  const readmeMd = (input.readmeMd ?? "").slice(0, PER_FILE_CHARS);
  const techSummary = (input.techSummary ?? "").slice(0, 2000);
  if (claudeMd) parts.push(`\n--- CLAUDE.md ---\n${claudeMd}`);
  if (readmeMd) parts.push(`\n--- README.md ---\n${readmeMd}`);
  if (techSummary) parts.push(`\n--- techSummary (manifest digest) ---\n${techSummary}`);
  const joined = parts.join("\n");
  // Hard cap on total input size so we don't blow the LLM context window on
  // a project with a giant CLAUDE.md.
  return joined.length > TOTAL_INPUT_CHARS ? joined.slice(0, TOTAL_INPUT_CHARS) : joined;
}

// Coerce arbitrary LLM-returned JSON into a ProjectSummary. Defensive: we
// don't trust the LLM to follow the schema exactly. Missing fields → empty
// arrays / objects; unknown enum values → coerced to safe defaults.
function coerceSummary(raw: unknown, model: string, sourceFiles: string[]): ProjectSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  const langSig = (o.languageSignals ?? {}) as Record<string, unknown>;
  return {
    purpose: typeof o.purpose === "string" ? o.purpose : "",
    keyCapabilities: Array.isArray(o.keyCapabilities) ? o.keyCapabilities.filter((s): s is string => typeof s === "string") : [],
    currentTech: (o.currentTech && typeof o.currentTech === "object" && !Array.isArray(o.currentTech))
      ? Object.fromEntries(
          Object.entries(o.currentTech as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>
      : {},
    outcomeGoals: Array.isArray(o.outcomeGoals)
      ? o.outcomeGoals
          .map((g) => {
            const gg = (g ?? {}) as Record<string, unknown>;
            const statement = typeof gg.statement === "string" ? gg.statement : null;
            if (!statement) return null;
            const source = gg.source === "user" ? "user" : "inferred";
            const confRaw = gg.confidence;
            const confidence: "high" | "medium" | "low" =
              source === "user" ? "high" :
              confRaw === "high" || confRaw === "medium" || confRaw === "low" ? confRaw : "medium";
            return { statement, source, confidence } as OutcomeGoal;
          })
          .filter((g): g is OutcomeGoal => g !== null)
      : [],
    crossRepoDependencies: Array.isArray(o.crossRepoDependencies)
      ? o.crossRepoDependencies
          .map((d) => {
            const dd = (d ?? {}) as Record<string, unknown>;
            const direction = dd.direction === "feeds_into" ? "feeds_into" : "consumes_from";
            const target = typeof dd.target === "string" ? dd.target : null;
            const description = typeof dd.description === "string" ? dd.description : "";
            if (!target) return null;
            return { direction, target, description } as CrossRepoDep;
          })
          .filter((d): d is CrossRepoDep => d !== null)
      : [],
    languageSignals: {
      hardConstraints: Array.isArray(langSig.hardConstraints)
        ? langSig.hardConstraints
            .map((c) => {
              const cc = (c ?? {}) as Record<string, unknown>;
              const capability = typeof cc.capability === "string" ? cc.capability : null;
              const allowed = Array.isArray(cc.allowedLanguages)
                ? cc.allowedLanguages.filter((s): s is string => typeof s === "string")
                : [];
              if (!capability || allowed.length === 0) return null;
              return { capability, allowedLanguages: allowed } as LanguageHardConstraint;
            })
            .filter((c): c is LanguageHardConstraint => c !== null)
        : [],
      detected: Array.isArray(langSig.detected)
        ? langSig.detected.filter((s): s is string => typeof s === "string")
        : [],
    },
    generatedAt: new Date().toISOString(),
    sourceFiles,
    llmModel: model,
    promptVersion: PROMPT_VERSION,
  };
}

export async function generateProjectSummary(input: SummarizeInput): Promise<ProjectSummary | null> {
  // Bail early if we have absolutely nothing to summarize. A project with no
  // docs and no manifest is invisible to the LLM — better to skip than to
  // hallucinate a summary from just the slug.
  if (!input.claudeMd && !input.readmeMd && !input.techSummary) {
    return null;
  }
  const sourceFiles = [
    input.claudeMd ? "CLAUDE.md" : null,
    input.readmeMd ? "README.md" : null,
    input.techSummary ? "techSummary" : null,
  ].filter((s): s is string => s !== null);

  const model = triageModel();
  const res = await chatCompletion(
    {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 2000,
    },
    { timeoutMs: 60_000, retries: 1 },
  );
  const text = res.choices?.[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn(`[summarize] ${input.slug} returned non-JSON: ${(e as Error).message}; sample: ${text.slice(0, 200)}`);
    return null;
  }
  return coerceSummary(parsed, model, sourceFiles);
}

// Cache-invalidation predicate. True if we need to (re)generate the summary.
export function needsRegeneration(args: {
  summaryJson: string | null;
  summaryHash: string | null;
  summaryGeneratedAt: Date | null;
  summaryPromptVersion: string | null;
  currentProfileHash: string;
}): { regen: boolean; reason: string } {
  if (!args.summaryJson) return { regen: true, reason: "no-summary" };
  if (args.summaryHash !== args.currentProfileHash) return { regen: true, reason: "profile-hash-changed" };
  if (args.summaryPromptVersion !== PROMPT_VERSION) return { regen: true, reason: "prompt-version-bumped" };
  if (!args.summaryGeneratedAt) return { regen: true, reason: "no-timestamp" };
  const ageMs = Date.now() - args.summaryGeneratedAt.getTime();
  if (ageMs > STALENESS_MS) return { regen: true, reason: `older-than-${Math.floor(STALENESS_MS / 86400000)}d` };
  return { regen: false, reason: "fresh" };
}
