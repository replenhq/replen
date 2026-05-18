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

const TARGETED_SYSTEM = `You are evaluating whether a newly-discovered open-source repo serves a SPECIFIC outcome that the project owner has said they want.

The outcome is given to you verbatim. Your job is to decide:
1. Does this repo concretely advance that outcome for THIS project?
2. If yes, what is the smallest practical first step to use it?
3. Is the fit incidental (just keyword overlap) or substantive?

WRITE IN PLAIN PROSE. NO markdown headers (no #, ##). NO bold "Summary:" labels. Use natural paragraphs separated by BLANK LINES (\\n\\n in the JSON string).

Structure your writeup:

(paragraph 1) 1-2 sentences on what the repo actually is — what it does, the tech stack, license, any constraints.

(paragraph 2) Bridge into project fit naturally. Name <PROJECT_NAME> and the specific subsystem the repo would plug into — actual modules / file paths / services from <PROJECT_NAME>'s CLAUDE.md or README. The system internally routed this candidate against a specific gap, but you do NOT need to quote that gap or use words like "outcome" or "goal" in the prose. Just describe what <PROJECT_NAME> gains and where it lands. Concrete, file-path-specific, 2-5 sentences. Read like a senior engineer pointing a colleague at a useful library — not like a structured product brief.

FORBIDDEN openers (over-used / read as templated):
- "For the outcome '...'"
- "Against the '...' goal"
- "On the '...' track"
- Any opener that puts an outcome/goal phrase in quotes.

If the repo offers multiple integration surfaces for this project, name as many as honestly apply — could be 1, could be 4. Don't pad to hit a number.

(paragraph 3) Smallest viable first slice: which one capability is fastest to wire up, rough time (hours/days), what it depends on.

Cardinal rules:
- Reference the user's project's actual components by name when possible.
- If the repo only matches by superficial keyword (e.g. the outcome mentions "operator" and so does the repo, but for an unrelated technical sense), set relevance="general-awareness" and write a short note explaining why it's NOT a real fit. Don't manufacture plausibility.
- If a "Candidate repo: source excerpts" block is provided, treat the source as ground truth and the README as a claim. A README that promises functionality not visible in the source is a strong signal of low relevance ("general-awareness"). Conversely, a sparse/generic README plus rich on-point source code is a positive signal.
- No filler ("could be useful", "interesting potential"). Every sentence carries information.
- 250-600 words for high/medium relevance; 60-150 for general-awareness.

Also fill the structured fields:
- relevance:
    "high"               → would integrate this month for THIS outcome
    "medium"             → real fit for THIS outcome, needs adaptation
    "general-awareness"  → repo is interesting but the outcome connection is weak/wrong
- relevanceScore 0-100. Conservative. Reserve >80 for cases where you can name a specific subsystem of the project the repo plugs into.
- summary: 1 sentence on what the repo is (no fit assessment).
- whyUseful: 1 sentence naming the single most important plug point for the outcome.
- suggestedUse: 1 sentence — the concrete first action.
- integrationApproach: cherry-pick | vendor | cleanroom-rebuild | depend-on-it | n/a
- risks: 1 sentence — license, abandoned, single maintainer, weird hooks, etc.

If the outcome is INFERRED (outcomeSource="inferred") rather than user-stated, apply a stricter relevance bar: be one step more conservative than you'd otherwise be (high→medium, medium→general-awareness) unless the connection is unmistakable. The user hasn't explicitly endorsed this outcome.

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

  const outcomeBlock = `## Outcome to evaluate against
Outcome (verbatim): ${attribution.outcome}
Source: ${attribution.outcomeSource} (${attribution.outcomeSource === "user" ? "stated by the project owner" : "inferred from project context"})
Confidence: ${attribution.outcomeConfidence}
The repo surfaced because its metadata matched the query term: "${attribution.matchedTerm}"`;

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
    const summary = sanitizeMarkdown(String(o.summary ?? "").trim());
    const risks = sanitizeMarkdown(String(o.risks ?? "").trim());
    const whyUseful = sanitizeMarkdown(String(o.whyUseful ?? "").trim());
    const suggestedUse = sanitizeMarkdown(String(o.suggestedUse ?? "").trim());

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
// "headers" the model occasionally leaks in. Kept inline rather than imported
// to avoid an analyzer→analyzer dep that would otherwise circle through
// reason.ts's larger surface.
function scrubWriteup(s: string): string {
  const stripped = s
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\s*\*\*[^*]+\*\*\s*:?\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sanitizeMarkdown(stripped);
}
