// Stage 2: gap identification (conservative-first). Reads the Stage-1
// ProjectSummary and produces targeted GitHub search vectors — each tied to
// a specific outcome goal the user actually cares about. See
// docs/stage-2-scope.md for the locked design.
//
// Stage 2 is a ROUTING decision, not a recommendation. The vectors feed
// Stage 3 (targeted GitHub search). Stage 4 (scoring) still reads the raw
// docs to evaluate fit — the summary is an index, not a source of truth.

import { chatCompletion, TRIAGE_MODEL } from "../analyzer/llm";
import type { ProjectSummary } from "./summarize";

// Bump when the prompt or output schema changes. Bumping invalidates all
// existing vector sets — they regenerate on next pipeline run.
export const VECTORS_PROMPT_VERSION = "3";

// Max age before we force-regenerate even if the summary hasn't changed.
// Looser than the summary ceiling (3 days) because vectors are derived from
// the summary; nothing else they care about drifts faster than the summary.
export const VECTORS_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

// Conservative caps. Together: max 5 vectors × 4 phrases = 20 GitHub queries
// per project per generation. With Stage-3 dedupe across projects this stays
// well under GitHub's 30 search-API-requests-per-minute authenticated limit.
const MAX_VECTORS = 5;
const MAX_TERMS_PER_VECTOR = 4;

export type SearchVector = {
  // The outcome goal this vector targets. Lifted verbatim from the summary
  // (not paraphrased) so attribution stays clean: when a match surfaces, the
  // dashboard can say "surfaced because you said you want <outcome>".
  outcome: string;
  outcomeSource: "user" | "inferred";
  // "high" is the default. "medium" appears only as a per-project fallback
  // when a project has zero high-confidence outcomes — returning nothing is
  // worse than searching with the LLM's best guess, as long as the UI labels
  // the lower confidence so Stage 4 can apply a stricter relevance bar.
  outcomeConfidence: "high" | "medium";
  // 1-4 distinct search phrases. Each is a concrete tool name, technical
  // term, or capability that would appear in the README of a tool that
  // solves the outcome. Vague phrases ("AI tools", "modern libraries") are
  // rejected at generation.
  queryTerms: string[];
  // Hard language constraint if the underlying outcome+capability genuinely
  // forces one. null = any language (the soft-signal default). Flows through
  // from the summary's languageSignals.hardConstraints ONLY — the LLM is
  // told not to invent constraints the summary didn't already lock.
  languageConstraint: string[] | null;
  // 1-2 sentences explaining why this vector exists. Surfaced in the UI so
  // the user can see Replen's reasoning when a match comes from this vector.
  reasoning: string;
};

export type SkippedGoal = {
  outcome: string;
  confidence: "medium" | "low";
};

export type ProjectSearchVectors = {
  vectors: SearchVector[];
  // Goals that didn't generate vectors because confidence was too low. Shown
  // in the UI as passive info ("Replen could search for these if you make
  // them explicit in CLAUDE.md"). No CTA — the user fixes by editing docs.
  skippedLowConfidence: SkippedGoal[];
  // Which confidence floor produced these vectors. "high" is the normal case;
  // "medium" means the project had zero high-confidence outcomes so we
  // fell back to medium. UI surfaces this so the user knows their docs are
  // thin and Stage 4 can tighten the relevance bar.
  confidenceFloor: "high" | "medium";
  generatedAt: string;
  sourceSummaryHash: string;
  llmModel: string;
  promptVersion: string;
};

const SYSTEM_PROMPT = `You generate targeted GitHub search queries for a software project, based on
the OUTCOMES its owner has said they care about.

INPUT: a structured project summary containing purpose, capabilities,
outcome goals (with source + confidence), current tech, and any HARD
language constraints. You read ONLY this summary.

OUTPUT: a small set of search vectors. Each vector targets ONE outcome goal
and provides 1-4 concrete GitHub search phrases.

RULES (these are not optional):

1. A "confidence floor" is set per-project in the user message. Skip any
   outcome whose effective confidence is below the floor:
   - floor=high: emit vectors for source=user OR confidence=high only.
     Skip medium and low (add to "skippedLowConfidence").
   - floor=medium: emit vectors for source=user OR confidence in (high, medium).
     Skip only low (add to "skippedLowConfidence").
   The floor=medium case fires only when the project has zero
   high-confidence outcomes — without it Replen returns nothing.

2. Each query phrase must be CONCRETE *and* SHORT. GitHub search matches
   against repo name/description/topics — long sentence-like phrases never
   appear verbatim there. Rules:
   - Tool names: 1-3 words ("scrapling", "playwright stealth", "argon2id")
   - Technical terms: 2-4 words ("cloudflare bypass", "concept drift",
     "Bayesian inference", "model monitoring")
   - Capabilities: 2-4 words ("incremental static regeneration",
     "explainable AI", "decision support")
   FORBIDDEN: sentences or 5+ word compound phrases like
   "explainable AI for course of action selection",
   "pairwise operator comparison UI",
   "operator benchmarking dashboard for SOP".
   Also FORBIDDEN: vague single terms — "AI tools", "modern libraries",
   "scraping" (alone), "performance improvements", "better alternatives".
   If you can't compress an idea to ≤4 words, find a related broader term
   that real repos actually use in their descriptions, or drop the phrase.

3. If you cannot generate at least ONE concrete phrase for an outcome, omit
   that vector entirely. Returning fewer high-quality vectors beats returning
   many vague ones.

4. Cap each vector at 4 phrases. Cap total vectors at 5. If the summary has
   more eligible outcomes than that, take the top 5 by source order:
   "user"-sourced first, then "inferred + high" — pick the most actionable.

5. Language constraints flow through from the summary's languageSignals.hardConstraints
   ONLY. If an outcome's underlying capability matches a hardConstraint
   capability, copy its allowedLanguages array into the vector. Otherwise
   set languageConstraint to null. NEVER invent a constraint.

6. "outcome" must be the verbatim statement from the summary's outcomeGoals.
   "outcomeSource" and "outcomeConfidence" must match the source data.

7. "reasoning" is 1-2 sentences explaining what these phrases target and why
   they fit the outcome. This text appears in the UI so the user can see
   what Replen is about to do.

Output JSON only. No prose before or after. Schema:
{
  "vectors": [
    {
      "outcome": "verbatim outcome from summary",
      "outcomeSource": "user" | "inferred",
      "outcomeConfidence": "high" | "medium",
      "queryTerms": ["concrete phrase 1", "concrete phrase 2"],
      "languageConstraint": null | ["ts", "js"],
      "reasoning": "1-2 sentences"
    }
  ],
  "skippedLowConfidence": [
    { "outcome": "the skipped outcome", "confidence": "medium" | "low" }
  ]
}`;

function buildUserPrompt(summary: ProjectSummary, confidenceFloor: "high" | "medium"): string {
  // We pass the summary as JSON, not as prose. The schema is the contract.
  // Cap at 8000 chars defensively — a typical summary is well under 2000.
  const json = JSON.stringify(summary, null, 2);
  const body = json.length > 8000 ? json.slice(0, 8000) : json;
  return `Confidence floor for this project: ${confidenceFloor}\n\nProject summary:\n\n${body}\n\nGenerate search vectors per the rules.`;
}

// Coerce arbitrary LLM JSON into a validated ProjectSearchVectors. The LLM
// may stray from the schema; we tolerate it gracefully and drop anything
// that doesn't conform.
function coerceVectors(
  raw: unknown,
  summary: ProjectSummary,
  summaryHash: string,
  model: string,
  confidenceFloor: "high" | "medium",
): ProjectSearchVectors {
  const o = (raw ?? {}) as Record<string, unknown>;
  const validOutcomeStatements = new Set(summary.outcomeGoals.map((g) => g.statement));

  const vectorsRaw = Array.isArray(o.vectors) ? o.vectors : [];
  const vectors: SearchVector[] = [];
  for (const v of vectorsRaw) {
    if (vectors.length >= MAX_VECTORS) break;
    const vv = (v ?? {}) as Record<string, unknown>;
    const outcome = typeof vv.outcome === "string" ? vv.outcome : null;
    if (!outcome) continue;

    // The LLM should always pick from the summary's actual goals. If it
    // hallucinated a new outcome, fall back to fuzzy-matching against the
    // summary; if none match, drop the vector (no inventing).
    const matchedGoal = summary.outcomeGoals.find((g) => g.statement === outcome)
      ?? summary.outcomeGoals.find((g) => normalize(g.statement) === normalize(outcome));
    if (!matchedGoal) continue;

    // Enforce the floor server-side regardless of what the LLM emitted.
    // user-sourced goals are always treated as "high" (the user wrote it down).
    const effectiveConfidence: "high" | "medium" | "low" =
      matchedGoal.source === "user" ? "high" : matchedGoal.confidence;
    const accept = confidenceFloor === "high"
      ? effectiveConfidence === "high"
      : effectiveConfidence === "high" || effectiveConfidence === "medium";
    if (!accept) continue;
    // Vectors only carry high|medium — low is always skipped.
    const vectorConfidence: "high" | "medium" =
      effectiveConfidence === "high" ? "high" : "medium";

    // queryTerms: keep only non-empty strings, dedupe, cap. Reject obvious
    // vague phrases AND phrases longer than 4 words (GitHub search would
    // return 0) as a safety net even though the prompt forbids them.
    const queryTerms = Array.isArray(vv.queryTerms)
      ? Array.from(
          new Set(
            vv.queryTerms
              .filter((t): t is string => typeof t === "string")
              .map((t) => t.trim())
              .filter((t) => t.length >= 2 && t.length <= 80)
              .filter((t) => !isVaguePhrase(t))
              .filter((t) => !isTooLong(t)),
          ),
        ).slice(0, MAX_TERMS_PER_VECTOR)
      : [];
    if (queryTerms.length === 0) continue;

    const languageConstraint = Array.isArray(vv.languageConstraint) && vv.languageConstraint.length > 0
      ? vv.languageConstraint.filter((s): s is string => typeof s === "string")
      : null;

    const reasoning = typeof vv.reasoning === "string" ? vv.reasoning : "";

    vectors.push({
      outcome: matchedGoal.statement,
      outcomeSource: matchedGoal.source,
      outcomeConfidence: vectorConfidence,
      queryTerms,
      languageConstraint,
      reasoning,
    });
  }

  // Reconcile skippedLowConfidence with the summary. Any goal not represented
  // in `vectors` AND whose effective confidence is below the floor is skipped.
  // Trust the summary; don't let the LLM omit goals it should have surfaced.
  const usedOutcomes = new Set(vectors.map((v) => v.outcome));
  const skippedLowConfidence: SkippedGoal[] = [];
  for (const g of summary.outcomeGoals) {
    if (usedOutcomes.has(g.statement)) continue;
    const confidence = g.source === "user" ? "high" : g.confidence;
    const wasEligible = confidenceFloor === "high"
      ? confidence === "high"
      : confidence === "high" || confidence === "medium";
    if (wasEligible) continue; // eligible-but-dropped = LLM judgement, not "skipped due to confidence"
    skippedLowConfidence.push({
      outcome: g.statement,
      confidence: confidence as "medium" | "low",
    });
  }

  return {
    vectors,
    skippedLowConfidence,
    confidenceFloor,
    generatedAt: new Date().toISOString(),
    sourceSummaryHash: summaryHash,
    llmModel: model,
    promptVersion: VECTORS_PROMPT_VERSION,
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Belt-and-braces: the prompt forbids these but the LLM occasionally returns
// them anyway. Reject server-side.
const VAGUE_PATTERNS = [
  /^ai (tools|libraries|frameworks)$/i,
  /^modern\b/i,
  /^better\b/i,
  /^improvements?$/i,
  /^alternatives?$/i,
  /^performance$/i,
  /^scraping$/i, // alone, no qualifier
  /^libraries$/i,
  /^tools$/i,
  /^frameworks?$/i,
];
function isVaguePhrase(s: string): boolean {
  const t = s.trim();
  // Single word is almost always too vague unless it's a known tool name.
  // Heuristic: single word ≤ 5 chars is fine (could be "argon2", "viem"),
  // single word > 5 chars without a hyphen / capital letter is suspect.
  if (!/\s/.test(t) && t.length > 5 && /^[a-z]+$/.test(t)) return true;
  return VAGUE_PATTERNS.some((re) => re.test(t));
}

// Phrases longer than 4 words rarely appear verbatim in GitHub repo
// name/description/topics, so the search always returns 0. Drop them.
function isTooLong(s: string): boolean {
  return s.trim().split(/\s+/).length > 4;
}

export async function generateSearchVectors(
  summary: ProjectSummary,
  summaryHash: string,
): Promise<ProjectSearchVectors | null> {
  // Pick the confidence floor: prefer high (conservative bias), but fall back
  // to medium when the project has zero high-confidence outcomes — without
  // the fallback, rich-doc-but-inferred projects (e.g. acme-web with 3
  // medium-confidence outcomes) get no vectors and Stage 3 returns nothing.
  const hasHigh = summary.outcomeGoals.some((g) => g.source === "user" || g.confidence === "high");
  const confidenceFloor: "high" | "medium" = hasHigh ? "high" : "medium";

  // If even the lowered floor wouldn't catch anything (no medium-or-better
  // goals at all), bail early with an empty result so the UI can render
  // "Replen has nothing concrete enough to search".
  const hasEligibleAtFloor = summary.outcomeGoals.some((g) => {
    const c = g.source === "user" ? "high" : g.confidence;
    return confidenceFloor === "high" ? c === "high" : c === "high" || c === "medium";
  });
  if (!hasEligibleAtFloor) {
    return {
      vectors: [],
      skippedLowConfidence: summary.outcomeGoals.map((g) => ({
        outcome: g.statement,
        confidence: (g.source === "user" ? "high" : g.confidence) as "medium" | "low",
      })),
      confidenceFloor,
      generatedAt: new Date().toISOString(),
      sourceSummaryHash: summaryHash,
      llmModel: TRIAGE_MODEL,
      promptVersion: VECTORS_PROMPT_VERSION,
    };
  }

  const model = TRIAGE_MODEL;
  const res = await chatCompletion(
    {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(summary, confidenceFloor) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 2500,
    },
    { timeoutMs: 60_000, retries: 1 },
  );
  const text = res.choices?.[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn(`[search-vectors] returned non-JSON: ${(e as Error).message}; sample: ${text.slice(0, 200)}`);
    return null;
  }
  return coerceVectors(parsed, summary, summaryHash, model, confidenceFloor);
}

// Hybrid cache-invalidation predicate, matching the Stage-1 pattern. True if
// we need to (re)generate vectors. Note the chain: profileHash → summaryHash
// → vectorsSummaryHash. If the summary refreshed, vectors must follow.
export function vectorsNeedRegeneration(args: {
  searchVectorsJson: string | null;
  searchVectorsSummaryHash: string | null;
  searchVectorsGeneratedAt: Date | null;
  searchVectorsPromptVersion: string | null;
  currentSummaryHash: string | null;
}): { regen: boolean; reason: string } {
  if (!args.currentSummaryHash) return { regen: false, reason: "no-summary-yet" };
  if (!args.searchVectorsJson) return { regen: true, reason: "no-vectors" };
  if (args.searchVectorsSummaryHash !== args.currentSummaryHash) {
    return { regen: true, reason: "summary-changed" };
  }
  if (args.searchVectorsPromptVersion !== VECTORS_PROMPT_VERSION) {
    return { regen: true, reason: "vectors-prompt-version-bumped" };
  }
  if (!args.searchVectorsGeneratedAt) return { regen: true, reason: "no-timestamp" };
  const ageMs = Date.now() - args.searchVectorsGeneratedAt.getTime();
  if (ageMs > VECTORS_STALENESS_MS) {
    return { regen: true, reason: `older-than-${Math.floor(VECTORS_STALENESS_MS / 86400000)}d` };
  }
  return { regen: false, reason: "fresh" };
}
