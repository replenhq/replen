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
import { applyScoreCap, computeRepoFlags } from "./score-cap";
import { ensureParagraphs } from "../lib/writeup-format";

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

const TARGETED_SYSTEM = `You're checking whether a newly-discovered OSS repo helps a specific project. Value comes in four forms - grade by the strongest one:
  depend-on-it: drop-in import
  cherry-pick: lift specific files/modules
  vendor: copy in-tree, adapt
  cleanroom-rebuild: take the IDEA, write your own (no code, no licence/dep burden)

A repo with strong rebuild value is medium-tier, not general-awareness. "Doesn't integrate" is not the same as "no value to surface."

SCORE BANDS (also drives writeup length AND structure):
  80-100  clear high-impact fit. 250-600 words across 3-5 paragraphs separated by blank lines (\\n\\n in the JSON string). Lead with the extraction path, name file paths from the project docs, give a time estimate.
  50-79   solid medium value. 250-600 words across 3-5 paragraphs, same structure as 80-100. Do NOT collapse a medium-tier writeup into a single dense block — split into paragraphs covering: what it is, where it plugs in, the trade-off / risk, the first concrete step.
  25-49   loose conceptual link. 60-150 words in 1-2 paragraphs. Name one specific thing worth knowing or studying. If you can't, score below 25.
  0-24    pure keyword overlap. ONE sentence. The pipeline drops these - no paragraphs, no "smallest viable first slice."

PARAGRAPH STRUCTURE IS NON-NEGOTIABLE for score 50+. The writeup field must contain at least two "\\n\\n" sequences (i.e. three or more paragraphs). A single-block writeup at score 50+ is treated as a formatting violation and will read poorly to the user.

WRITING STYLE (writeup, summary, whyUseful, suggestedUse, risks):
  - No em dashes (—) or en dashes (–). Use commas or sentence breaks. Hyphens between words (drop-in, co-operative) are fine.
  - Mix paragraph lengths. Punchy one-liners next to 2-3 sentence groups. Avoid uniform walls of text.
  - Lead with substance, not setup phrases ("This repo provides...", "It is important to note...").
  - Don't use the words "outcome" or "goal" - use "need" or describe directly. Don't quote the need verbatim; the UI shows it separately.
  - Reference actual project components (modules, file paths, services) by name when grading 50+.
  - No filler ("could be useful", "interesting potential"). Every sentence carries information.

GRADING NOTES:
  - Don't dismiss a real fit because the project already has overlapping infra. New capability (better algorithm, friendlier licence, less ops burden, cleaner drop-in) still grades up.
  - "Planned, not yet wired" or "what's NOT in scope" sections in the project docs are STRONG opportunities - grade up if the repo fills one.
  - If a "Currently building" block is provided, it lists what the user is actively working on THIS PERIOD. A match that fits the current work (themes, recent files, branch) grades stronger than one that fits only the project's general doc shape, AND should be referenced in the writeup by name (theme tag, file path, or PR number). If the candidate is unrelated to the current work but still useful for the project's general shape, grade normally without forcing the link.
  - If a "Candidate repo: source excerpts" block is provided, treat the source as ground truth and the README as a claim.
  - Hedging phrases ("could be useful", "this can help") are fine WHEN immediately followed by a specific claim. They are NOT fine as standalone filler.

CITATION REQUIREMENT (for score 80+):
The writeup MUST cite at least one specific identifier from the CANDIDATE repo's README, wrapped in backticks — file path, function/CLI name, class, or similar. Naming a project file from the USER's docs doesn't count; the citation has to anchor the candidate's actual capability. If you can't name a concrete thing the candidate ships, the score is below 80.

ANTI-HALLUCINATION:
Score reflects substance, not articulation. Do NOT invent integration angles the candidate's README doesn't demonstrate. If you have to stretch the candidate's stated purpose to fit (a game-platform deployment tool used as a generic rsync replacement, a media downloader recommended as a tunnel manager, etc.), score below 50. Keyword overlap is not capability.

APPROACH MUST MATCH RISK PROFILE:
Risk signals (no license, alpha/pre-release, abandoned, single maintainer, wrong language family for full adoption) constrain which integrationApproach is honest — not the score itself. Match approach to what's safe:
- "depend-on-it" / "vendor" → license must be permissive, language must match, project must be production-ready and maintained.
- "cherry-pick" → license still matters (you're copying code), but alpha/dormant don't disqualify.
- "cleanroom-rebuild" → no disqualifiers. Any repo with a good IDEA is fair game.
If a signal forces you to a less-binding approach, take it; score the value of the approach you chose.

Output JSON only:
{
  "relevance": "high" | "medium" | "general-awareness",
  "relevanceScore": 0,
  "summary": "1 sentence on what the repo is",
  "whyUseful": "1 sentence: the single most valuable thing (plug point OR idea to lift)",
  "suggestedUse": "1 sentence: the concrete first action",
  "integrationApproach": "depend-on-it" | "cherry-pick" | "vendor" | "cleanroom-rebuild" | "n/a",
  "risks": "1 sentence: licence / abandoned / single maintainer / etc.",
  "writeup": "the prose as described above"
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

  const activityBlock = renderActivityBlock(project.activitySummary);

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

  // Activity block goes BETWEEN projectBlock and outcomeBlock so the LLM
  // reads "what they generally do" -> "what they're doing this period" ->
  // "specific need being checked" -> "candidate repo". The order matters:
  // current work is context for the specific need, not for the project as
  // a whole.
  const userParts = [projectBlock];
  if (activityBlock) userParts.push(activityBlock);
  userParts.push(outcomeBlock, repoBlock);
  if (sourceBlock) userParts.push(sourceBlock);

  const res = await chatCompletion(
    {
      provider,
      model,
      max_tokens: 4500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${TARGETED_SYSTEM}\n\n${UNTRUSTED_CONTENT_RULE}` },
        { role: "user", content: userParts.join("\n\n") },
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

    const writeup = ensureParagraphs(scrubWriteup(String(o.writeup ?? "").trim()));
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

    // Mechanical score caps — see score-cap.ts. Backstop for cases where the
    // LLM scored confidently despite a risk signal that should have demoted.
    const approach = (o.integrationApproach as ProjectAssessment["integrationApproach"]) ?? "n/a";
    const flags = computeRepoFlags(safety, writeup);
    const capped = applyScoreCap({
      rawScore: Number(o.relevanceScore ?? 0),
      rawRelevance: rel as ProjectAssessment["relevance"],
      approach,
      flags,
    });
    if (capped.demotions.length > 0 && capped.score !== Number(o.relevanceScore ?? 0)) {
      console.log(`[score-targeted:cap] ${safety.meta.owner}/${safety.meta.name} → ${project.slug}: ${o.relevanceScore}→${capped.score} (${capped.demotions.join("; ")})`);
    }

    return {
      projectSlug: project.slug,
      relevance: capped.relevance,
      relevanceScore: capped.score,
      summary,
      whyUseful,
      suggestedUse,
      integrationApproach: approach,
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

// Render the "Currently building" block from a project's cached activity
// summary. Returns null when there's no signal (dormant project, no cached
// summary yet) so callers can skip the section entirely rather than feed
// the LLM an empty placeholder.
//
// Exported so reason.ts (the discovery path) and any future scoring layer
// can use the same exact block shape. The system prompt's "Currently
// building" reference assumes this rendering.
export function renderActivityBlock(activity: import("../projects/activity-summary").ProjectActivitySummary | null | undefined): string | null {
  if (!activity || activity.state !== "active" || !activity.summary) return null;
  const parts = [`## Currently building (last 30 days)`, activity.summary];
  if (activity.themes.length > 0) {
    parts.push(`Themes: ${activity.themes.join(", ")}`);
  }
  if (activity.topFiles.length > 0) {
    parts.push(`Recent files: ${activity.topFiles.slice(0, 8).join(", ")}`);
  }
  return parts.join("\n");
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
