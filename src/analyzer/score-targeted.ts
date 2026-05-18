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

const TARGETED_SYSTEM = `You are evaluating whether a newly-discovered open-source repo serves a SPECIFIC need that the project owner has stated (or that we've inferred from their docs).

The need is given to you verbatim. Your job is to decide:
1. Does this repo concretely advance that need for THIS project?
2. If yes, what is the smallest practical first step to use it?
3. Is the fit incidental (just keyword overlap) or substantive?

WRITE IN PLAIN PROSE. NO markdown headers (no #, ##). NO bold "Summary:" labels. Use natural paragraphs separated by BLANK LINES (\\n\\n in the JSON string).

Structure your writeup:

(paragraph 1) 1-2 sentences on what the repo actually is — what it does, the tech stack, license, any constraints.

(paragraph 2) Bridge into project fit naturally. Name <PROJECT_NAME> and the specific subsystem the repo would plug into — actual modules / file paths / services from <PROJECT_NAME>'s CLAUDE.md or README. Describe what <PROJECT_NAME> gains and where it lands. Concrete, file-path-specific, 2-5 sentences. Read like a senior engineer pointing a colleague at a useful library — not like a structured product brief.

BANNED VOCABULARY — the following words MUST NOT appear anywhere in the writeup body (summary / whyUseful / suggestedUse / risks too):
- "outcome", "outcomes"
- "goal", "goals" (use "need", "what <PROJECT_NAME> needs", or just describe directly)
- "the outcome 'X'", "the goal 'X'" (any quoted framing of the routing signal)

If you find yourself wanting to write "for the outcome X" or "for the X goal", rephrase as "for <PROJECT_NAME>'s <whatever it actually is>" or just talk about the concrete need directly. The need is already shown in the UI separately; do not echo it back as framing in the writeup.

FORBIDDEN openers (over-used / read as templated):
- "For <PROJECT_NAME> specifically..."
- "Against the '...' goal", "On the '...' track"
- Any opener that quotes the need verbatim.

If the repo offers multiple integration surfaces for this project, name as many as honestly apply — could be 1, could be 4. Don't pad to hit a number.

(paragraph 3) Smallest viable first slice: which one capability is fastest to wire up, rough time (hours/days), what it depends on.

Cardinal rules:
- Reference the user's project's actual components by name when possible.
- If the repo only matches by superficial keyword (the routing signal mentions "operator" and so does the repo, but for an unrelated technical sense), set relevance="general-awareness" and write a short note explaining why it's NOT a real fit. Don't manufacture plausibility.
- EQUALLY: don't dismiss a real fit just because the project already has overlapping infrastructure. If the repo brings a genuinely new capability (better algorithm, broader coverage, friendlier licence, less ops burden, drop-in replacement that's cleaner), say so and grade it high or medium. Parallel infrastructure ≠ no fit.
- "Planned, not yet wired" features and "what's NOT in scope" sections in the project docs are STRONG integration opportunities — if the repo fills one of those gaps, grade up, not down.
- If a "Candidate repo: source excerpts" block is provided, treat the source as ground truth and the README as a claim. A README that promises functionality not visible in the source is a strong signal of low relevance. Conversely, a sparse README plus rich on-point source code is a positive signal.
- No filler ("could be useful", "interesting potential"). Every sentence carries information.
- 250-600 words for high/medium relevance; 60-150 for general-awareness.

Also fill the structured fields:
- relevance:
    "high"               → would integrate this month — names a specific subsystem, brings real new capability
    "medium"             → real fit, needs adaptation or has known caveats
    "general-awareness"  → keyword overlap only, domain mismatch, or fully redundant with existing infra
- relevanceScore 0-100. Calibration:
    80-100: clear high-impact fit; concrete integration in days
    50-79:  solid medium fit; needs adaptation
    25-49:  marginal; conceptual overlap, integration is hard
    0-24:   general-awareness only
- summary: 1 sentence on what the repo is (no fit assessment).
- whyUseful: 1 sentence naming the single most important plug point.
- suggestedUse: 1 sentence — the concrete first action.
- integrationApproach: cherry-pick | vendor | cleanroom-rebuild | depend-on-it | n/a
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
    .replace(/\bgoal\b/gi, (m) => (m[0] === m[0].toUpperCase() ? "Need" : "need"));
}
