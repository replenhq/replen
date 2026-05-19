// Stage 4: outcome-attributed scoring. Reads ONE Stage-3 candidate (which
// already knows which project it's for AND which outcome it was meant to
// serve) and asks the LLM: "does this repo specifically help with this
// outcome?"
//
// Differences from analyzer/reason.ts:
//   - reason.ts shortlists projects from a fresh repo (no attribution).
//     It asks "which of these projects could this fit?" — a discovery
//     question. Used for HN/Reddit/trending candidates.
//   - score-targeted.ts knows the project AND the outcome up-front (from
//     gh-targeted attribution). It asks "does this serve outcome X for
//     project Y?" — a verification question. One LLM call per candidate,
//     no shortlist pass.
//
// Per locked principles:
//   - Reads raw project docs (readmeMd, claudeMd, techSummary), NOT the
//     persisted summary. The summary is a routing index only.
//   - Surfaces the outcome verbatim so the UI can show "Replen surfaced
//     this because you said you want <outcome>".
//   - High-sensitivity projects route to Anthropic, fail-closed when the
//     key is missing.

import { chatCompletion, hasAnthropicKey, reasoningModel, reasoningModelHigh } from "./llm";
import type { SafetyReport } from "../scanner/safety";
import type { LocalProject } from "../projects/loader";
import { sanitizeUntrusted, UNTRUSTED_CONTENT_RULE, looksLikeInjectionLeak } from "./guards";
import { sanitizeMarkdown } from "../lib/markdown-sanitize";
import type { ProjectAssessment } from "./reason";
import { renderSourceBlock, type FormattedExcerpt } from "./source-context";

export type TargetedAssessment = ProjectAssessment & {
  matchedOutcome: string;
  matchedOutcomeSource: "user" | "inferred";
  matchedOutcomeConfidence: "high" | "medium";
};

export type TargetedAttribution = {
  outcome: string;
  outcomeSource: "user" | "inferred";
  outcomeConfidence: "high" | "medium";
  matchedTerm: string; // which queryTerm hit GitHub (debugging)
};

const TARGETED_SYSTEM = `You are evaluating a newly-discovered open-source repo against a SPECIFIC need that the project owner has stated (or that we've inferred from their docs). Your job is to extract VALUE — not just to assess whether the whole repo can be integrated.

Value comes in multiple forms. A great repo for this user might:
- Integrate end-to-end (high fit). Or:
- Integrate a couple of components, ignore the rest (cherry-pick).
- Offer a clever ALGORITHM, DATA MODEL, or ARCHITECTURE the user can reimplement in-house (idea extraction — equally valuable, often more so since you bypass the licence + dep-tree burden).
- Show a UX pattern, product decision, or framing worth borrowing.
- Be a competitor with features worth re-building.

Your evaluation should answer THREE questions:
1. Can the project integrate this repo (whole / cherry-picked / vendored)? At what cost?
2. If integration is unattractive, what specific IDEAS or PATTERNS could the project owner study and rebuild in-house?
3. Is the connection substantive at any of those levels, or pure keyword overlap?

A repo that scores low on #1 but high on #2 is still valuable. "Doesn't integrate" is NOT the same as "no value to surface." Only when both are weak (#3 = pure keyword overlap) should you drop the score below 25.

WRITE IN PLAIN PROSE. NO markdown headers (no #, ##). NO bold "Summary:" labels. Use natural paragraphs separated by BLANK LINES (\\n\\n in the JSON string).

WRITING STYLE — these rules apply to writeup, summary, whyUseful, suggestedUse, and risks:
- NO em dashes (—). NO en dashes (–). Use a comma or a sentence break instead. Hyphens between words (e.g. "drop-in", "cherry-pick", "co-operative", "20-day") are fine because those are normal ASCII hyphens, not dashes; the ban is on unicode dashes only.
- Vary paragraph lengths. Some sentences stand alone as a single-line paragraph. Others group 2-3 sentences. Avoid uniform 5-sentence walls of text.
- Aim for visual rhythm: a punchy one-liner, then a longer paragraph, then another short one. Make the page scannable.
- Start with the lede, not the setup. Don't open with "It is important to note that..." or "This repo provides...". Open with what the user actually needs to know.

Structure your writeup:

(paragraph 1) 1-2 sentences on what the repo actually is — what it does, the tech stack, license, any constraints.

(paragraph 2) Bridge into project value. Name <PROJECT_NAME> and either (a) the specific subsystem the repo plugs into, with actual modules / file paths / services from the docs, OR (b) the specific idea / pattern / approach worth lifting if whole-repo integration doesn't fit. Concrete, 2-5 sentences. Read like a senior engineer who's already mentally mined the repo for what's useful — not like a procurement checklist.

BANNED VOCABULARY — the following words MUST NOT appear anywhere in the writeup body (summary / whyUseful / suggestedUse / risks too):
- "outcome", "outcomes"
- "goal", "goals" (use "need", "what <PROJECT_NAME> needs", or just describe directly)
- "the outcome 'X'", "the goal 'X'" (any quoted framing of the routing signal)

If you find yourself wanting to write "for the outcome X" or "for the X goal", rephrase as "for <PROJECT_NAME>'s <whatever it actually is>" or just talk about the concrete need directly. The need is already shown in the UI separately; do not echo it back as framing in the writeup.

FORBIDDEN openers (over-used / read as templated):
- "For <PROJECT_NAME> specifically..."
- "Against the '...' goal", "On the '...' track"
- Any opener that quotes the need verbatim.

If the repo offers multiple integration surfaces OR multiple ideas worth lifting, name as many as honestly apply — could be 1, could be 4. Don't pad to hit a number.

(paragraph 3) Concrete next step. EITHER the smallest viable integration slice (rough time, what it depends on), OR — if the repo isn't an integration candidate but has good ideas — name the specific pattern / algorithm / UX move worth studying and what the cleanroom-rebuild looks like. Time estimate either way.

Cardinal rules:
- Reference the user's project's actual components by name when possible.
- Integration isn't the only form of value. If the repo isn't a good fit to import but has a clear pattern / algorithm / data model / UX decision worth lifting into the project's own codebase, say so and grade it medium (50-79) with integrationApproach="cleanroom-rebuild". A repo that gives the user 1-2 substantial ideas to build in-house is medium-tier value, not general-awareness.
- Don't dismiss a real fit just because the project already has overlapping infrastructure. If the repo brings genuinely new capability (better algorithm, broader coverage, friendlier licence, less ops burden, cleaner drop-in), grade it high or medium.
- "Planned, not yet wired" features and "what's NOT in scope" sections in the project docs are STRONG opportunities — if the repo fills one of those gaps, grade up.
- If a "Candidate repo: source excerpts" block is provided, treat the source as ground truth and the README as a claim.
- Pure keyword overlap with NO extractable value (not integration, not ideas) → set relevance="general-awareness" with score 0-24 and write a SINGLE sentence. The pipeline drops these.
- No filler ("could be useful", "interesting potential"). Every sentence carries information.

Also fill the structured fields:
- relevance:
    "high"               → integrate this month, OR multiple substantial cherry-picks
    "medium"             → real integration with adaptation, OR 1-2 substantive ideas/patterns worth a cleanroom-rebuild
    "general-awareness"  → loose conceptual overlap; might be worth knowing exists but no clear action
- relevanceScore 0-100. Calibration:
    80-100: clear high-impact fit (integration OR multiple borrowable patterns)
    50-79:  solid medium value (integrate-with-adaptation, OR 1-2 specific ideas to rebuild in-house)
    25-49:  loose conceptual link; worth noting but probably no action
    0-24:   pure keyword overlap, no value extractable — gets dropped

WRITEUP LENGTH BY SCORE BAND:
    score 0-24: ONE SENTENCE only. e.g. "<repo> is unrelated to <PROJECT_NAME> — superficial keyword match on '<term>' only." No paragraphs, no "smallest viable first slice." The pipeline drops these.
    score 25-49: 60-150 words. Explain the loose connection AND name any specific thing worth knowing or studying (even a single idea). If you can't name anything, the score should have been below 25.
    score 50-100: full 250-600 words. Lead with the highest-value extraction path (integration OR idea-lifting), include the concrete next step.
- summary: 1 sentence on what the repo is (no fit assessment).
- whyUseful: 1 sentence naming the single most valuable thing (plug point OR idea to lift).
- suggestedUse: 1 sentence — the concrete first action (wire it up, OR study + rebuild X).
- integrationApproach:
    "depend-on-it"      → import directly, lightest touch
    "cherry-pick"       → lift specific files / functions / modules into the project
    "vendor"            → copy the repo in-tree, adapt as needed
    "cleanroom-rebuild" → take the IDEA, write your own version (no code transferred; bypass licence/dep burden)
    "n/a"               → nothing to integrate or rebuild
- risks: 1 sentence — license, abandoned, single maintainer, weird hooks, etc.

If the need is INFERRED rather than user-stated, hold a slightly stricter bar on whether the connection is real — but ONLY downgrade if the fit itself is weak. A clear, concrete fit on an inferred need still earns high or medium. Do not auto-downgrade by one tier; that's overcorrection.

Output JSON ONLY:
{
  "relevance": "...",
  "relevanceScore": 0,
  "summary": "...",
  "whyUseful": "...",
  "suggestedUse": "...",
  "integrationApproach": "...",
  "risks": "...",
  "writeup": "<the prose as described above>"
}`;

export async function scoreTargetedCandidate(
  safety: SafetyReport,
  project: LocalProject,
  attribution: TargetedAttribution,
  opts: { sourceExcerpts?: FormattedExcerpt[] } = {},
): Promise<TargetedAssessment | null> {
  // High-sensitivity gate — fail-closed.
  const override = project.llmProvider ?? "auto";
  let provider: "deepseek" | "anthropic";
  if (override === "deepseek" || override === "anthropic") {
    provider = override;
  } else {
    provider = project.sensitivity === "high" ? "anthropic" : "deepseek";
  }
  if (provider === "anthropic" && !hasAnthropicKey()) {
    console.warn(`[score-targeted] skipping ${project.slug}: Anthropic requested but key missing`);
    return null;
  }
  const model = provider === "anthropic" ? reasoningModelHigh() : reasoningModel();

  const projectBlock = `## Project: ${project.name} (slug: ${project.slug})

${sanitizeUntrusted((project.readmeMd ?? "").slice(0, 8000), "PROJECT_README")}

${project.claudeMd ? sanitizeUntrusted(project.claudeMd.slice(0, 10000), "PROJECT_CLAUDE_MD") + "\n\n" : ""}Tech: ${project.techSummary ?? "(none)"}`;

  const outcomeBlock = `## Specific need this candidate is being checked against
Need (verbatim, from the project's docs or inferred from them): ${attribution.outcome}
Source: ${attribution.outcomeSource === "user" ? "stated by the project owner in their docs" : "inferred from project context"}
Confidence: ${attribution.outcomeConfidence}
The repo surfaced because its metadata matched the query term: "${attribution.matchedTerm}"

REMEMBER: do NOT echo this need verbatim in your writeup. Describe the fit directly without referencing the framing.`;

  const repoBlock = `## Candidate repo: ${safety.meta.owner}/${safety.meta.name}

URL: https://github.com/${safety.meta.owner}/${safety.meta.name}
Stars: ${safety.meta.stars} · Forks: ${safety.meta.forks} · Age: ${safety.ageDays}d · Last push: ${safety.daysSincePush}d ago
Contributors: ${safety.contributorCount} · Language: ${safety.meta.language ?? "?"} · License: ${safety.meta.license ?? "?"}
Description: ${safety.meta.description ?? "(none)"}

Safety scan:
- risk level: ${safety.riskLevel}
- postinstall hooks: ${safety.postinstallHooks.join("; ") || "none"}
- suspicious patterns: ${safety.suspiciousPatterns.join(", ") || "none"}

${sanitizeUntrusted(safety.readmeMd.slice(0, 15000), "REPO_README")}`;

  // Source excerpts are wrapped in the same untrusted-content sanitizer as the
  // README — they come from a third-party repo, so the same prompt-injection
  // surface applies. The renderer returns null when there are no excerpts,
  // which keeps the prompt clean rather than including an empty section.
  const sourceBlockRaw = opts.sourceExcerpts ? renderSourceBlock(opts.sourceExcerpts) : null;
  const sourceBlock = sourceBlockRaw ? sanitizeUntrusted(sourceBlockRaw, "REPO_SOURCE") : null;

  const res = await chatCompletion(
    {
      provider,
      model,
      max_tokens: 4500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${TARGETED_SYSTEM}\n\n${UNTRUSTED_CONTENT_RULE}` },
        {
          role: "user",
          content: sourceBlock
            ? `${projectBlock}\n\n${outcomeBlock}\n\n${repoBlock}\n\n${sourceBlock}`
            : `${projectBlock}\n\n${outcomeBlock}\n\n${repoBlock}`,
        },
      ],
    },
    { timeoutMs: 180_000, retries: 2 }
  );

  const text = res.choices[0]?.message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    console.warn(`[score-targeted] ${safety.meta.owner}/${safety.meta.name} → ${project.slug}: no JSON in response (len=${text.length})`);
    return null;
  }
  try {
    const o = JSON.parse(m[0]);
    const rel = (o.relevance as string) ?? "general-awareness";
    if (rel !== "high" && rel !== "medium" && rel !== "general-awareness") {
      console.warn(`[score-targeted] ${safety.meta.owner}/${safety.meta.name} → ${project.slug}: bad relevance value=${JSON.stringify(rel)}`);
      return null;
    }

    const writeup = scrubWriteup(String(o.writeup ?? "").trim());
    const summary = sanitizeMarkdown(scrubBannedVocab(String(o.summary ?? "").trim()));
    const risks = sanitizeMarkdown(scrubBannedVocab(String(o.risks ?? "").trim()));
    const whyUseful = sanitizeMarkdown(scrubBannedVocab(String(o.whyUseful ?? "").trim()));
    const suggestedUse = sanitizeMarkdown(scrubBannedVocab(String(o.suggestedUse ?? "").trim()));

    // Drop the result if the model fell for prompt injection. Same logic as
    // reason.ts deepWriteup: better empty than poisoned.
    const owner = safety.meta.owner;
    const leakReason =
      looksLikeInjectionLeak(writeup, owner) ||
      looksLikeInjectionLeak(summary, owner) ||
      looksLikeInjectionLeak(risks, owner);
    if (leakReason) {
      console.warn(`[score-targeted] dropping ${safety.meta.owner}/${safety.meta.name} → ${project.slug}: ${leakReason}`);
      return null;
    }

    return {
      projectSlug: project.slug,
      relevance: rel as ProjectAssessment["relevance"],
      relevanceScore: Number(o.relevanceScore ?? 0),
      summary,
      whyUseful,
      suggestedUse,
      integrationApproach: (o.integrationApproach as ProjectAssessment["integrationApproach"]) ?? "n/a",
      risks,
      writeup,
      matchedOutcome: attribution.outcome,
      matchedOutcomeSource: attribution.outcomeSource,
      matchedOutcomeConfidence: attribution.outcomeConfidence,
    };
  } catch (err) {
    console.warn(`[score-targeted] ${safety.meta.owner}/${safety.meta.name} → ${project.slug}: JSON parse failed: ${(err as Error).message}`);
    return null;
  }
}

// Same scrub as reason.ts — strip markdown headers and standalone bold
// "headers" the model occasionally leaks in, then strip banned vocabulary
// (outcome/outcomes/goal/goals) that templates the writeup. Kept inline
// rather than imported to avoid an analyzer→analyzer dep that would
// otherwise circle through reason.ts's larger surface.
function scrubWriteup(s: string): string {
  const stripped = s
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\s*\*\*[^*]+\*\*\s*:?\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sanitizeMarkdown(scrubBannedVocab(stripped));
}

// Strip the model's templated "outcome/goal" framing when it leaks through
// despite the system-prompt ban. Surgical word-level replacements rather
// than sentence-level — sentences carrying these words usually still have
// substantive content, we just want the framing words swapped.
//
// "the outcome 'X'" / "the goal 'X'" — the LLM's most common echo back of
// the routing signal — is rewritten to "this fit" since the X phrase is
// already shown in the UI's "Surfaced because you want: X" line.
export function scrubBannedVocab(s: string): string {
  return s
    // Strip the quoted-need echo patterns first (more specific). Catches
    // smart-quotes too.
    .replace(/\bthe\s+(outcome|goal)s?\s+['"‘’“”][^'"‘’“”]+['"‘’“”]/gi, "this fit")
    .replace(/\b(?:project'?s?|inferred|stated|the)\s+(outcome|goal)s?\b/gi, (m) => m.replace(/(outcome|goal)s?/i, "need"))
    // Generic word swaps. \b boundaries avoid mangling words like
    // "outcomeSource" (no \b before 'S' since both are word chars).
    // Case-preserving so sentence-starting "Outcome" → "Need", not "need".
    .replace(/\boutcomes\b/gi, (m) => (m[0] === m[0].toUpperCase() ? "Needs" : "needs"))
    .replace(/\boutcome\b/gi, (m) => (m[0] === m[0].toUpperCase() ? "Need" : "need"))
    .replace(/\bgoals\b/gi, (m) => (m[0] === m[0].toUpperCase() ? "Needs" : "needs"))
    .replace(/\bgoal\b/gi, (m) => (m[0] === m[0].toUpperCase() ? "Need" : "need"))
    // Em/en dash → comma. The model loves these for parenthetical clauses
    // ("FooBar is a Python library — actively maintained — that does X").
    // User prefers natural sentence punctuation. Hyphens between words
    // ("drop-in", "co-operative") stay untouched because those use the
    // ASCII hyphen `-`, not the unicode em/en dash characters.
    // The pattern consumes surrounding whitespace so " — " collapses to
    // ", " (no double-space). The unspaced "word—word" form is rarer but
    // covered too.
    .replace(/\s*[—–]\s*/g, ", ");
}
