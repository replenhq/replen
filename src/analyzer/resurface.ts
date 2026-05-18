// Bookmark resurface scoring: given an existing bookmarked general-awareness
// match and a different project than the one it was bookmarked from, ask the
// LLM whether the repo serves any of the new project's outcome goals.
//
// Differs from score-targeted.ts in one key way: the targeted scorer is given
// ONE outcome (from Stage 3 attribution) and asked to verify fit. The resurface
// scorer is given the project's FULL list of outcomes and asks the LLM to pick
// the best fit — or to return matchedOutcome=null when nothing fits.
//
// See docs/bookmark-resurface-scope.md.

import { chatCompletion, hasAnthropicKey, reasoningModel, reasoningModelHigh } from "./llm";
import type { SafetyReport } from "../scanner/safety";
import type { LocalProject } from "../projects/loader";
import type { OutcomeGoal } from "../projects/summarize";
import { sanitizeUntrusted, UNTRUSTED_CONTENT_RULE, looksLikeInjectionLeak } from "./guards";
import { sanitizeMarkdown } from "../lib/markdown-sanitize";
import type { ProjectAssessment } from "./reason";
import type { TargetedAssessment } from "./score-targeted";

export type ResurfaceInput = {
  safety: SafetyReport;
  project: LocalProject;
  outcomes: OutcomeGoal[];
  bookmarkedAt: Date;
};

const RESURFACE_SYSTEM = `You are re-evaluating a repository the user BOOKMARKED earlier (saved as "interesting, maybe later") against a project they own. Your job is to decide whether this bookmark now looks like a fit for one of THIS project's outcome goals.

You are given:
- The bookmarked repository (README + safety scan).
- This project's docs (README, CLAUDE.md, techSummary).
- This project's outcome goals — each tagged with source ('user' = the user wrote this themselves; 'inferred' = LLM derived) and confidence.
- The date the user originally bookmarked this repo.

Decide:
1. Does this repo concretely serve any of the listed outcome goals for THIS project?
2. If yes, which outcome is the best fit? (You MUST quote it VERBATIM from the list.)
3. Is the fit substantive or just superficial keyword overlap?

WRITE IN PLAIN PROSE. NO markdown headers. NO bold "Summary:" labels. Use natural paragraphs separated by BLANK LINES (\\n\\n in the JSON string).

Structure your writeup (when relevance >= medium):
(paragraph 1) 1-2 sentences on what the repo actually is.
(paragraph 2) Lead with: "You bookmarked this on <BOOKMARK_DATE>. For the outcome '<OUTCOME>', it would let <PROJECT_NAME> <CONCRETE GAIN>." Then 2-4 sentences on the specific connection.
(paragraph 3) Smallest viable first slice: which capability is fastest to wire up.

Cardinal rules:
- If NO outcome fits, set relevance="general-awareness", matchedOutcome=null, and write a short note (60-150 words) explaining why this bookmark doesn't serve any of the listed outcomes.
- The 'matchedOutcome' MUST be a verbatim copy of one of the outcome statements provided, OR null. Paraphrasing is a bug.
- Reference the project's actual components by name when possible.
- No filler. Every sentence carries information.
- 250-600 words for high/medium; 60-150 for general-awareness.

Conservative bias on inferred outcomes: if the best-fitting outcome is source='inferred', be one step stricter (high→medium, medium→general-awareness) unless the connection is unmistakable.

Output JSON ONLY:
{
  "matchedOutcome": "...verbatim outcome statement..." | null,
  "matchedOutcomeSource": "user" | "inferred" | null,
  "matchedOutcomeConfidence": "high" | "medium" | "low" | null,
  "relevance": "high" | "medium" | "general-awareness",
  "relevanceScore": 0,
  "summary": "...",
  "whyUseful": "...",
  "suggestedUse": "...",
  "integrationApproach": "cherry-pick | vendor | cleanroom-rebuild | depend-on-it | n/a",
  "risks": "...",
  "writeup": "<the prose as described>"
}`;

export type ResurfaceResult =
  | { kind: "match"; assessment: TargetedAssessment }
  | { kind: "no-fit" }
  | { kind: "error" };

export async function scoreBookmarkAgainstProject(input: ResurfaceInput): Promise<ResurfaceResult> {
  const { safety, project, outcomes, bookmarkedAt } = input;

  // Filter outcomes the LLM is allowed to pick: drop low-confidence inferred
  // goals (Stage 2 already ignores these for new searches; the resurface
  // pass honours the same conservative bias). User-attributed goals are
  // always 'high' confidence per the summarize.ts invariant.
  const eligible = outcomes.filter((g) => g.source === "user" || g.confidence === "high" || g.confidence === "medium");
  if (eligible.length === 0) return { kind: "no-fit" };

  // High-sensitivity gate — fail-closed.
  const override = project.llmProvider ?? "auto";
  let provider: "deepseek" | "anthropic";
  if (override === "deepseek" || override === "anthropic") provider = override;
  else provider = project.sensitivity === "high" ? "anthropic" : "deepseek";
  if (provider === "anthropic" && !hasAnthropicKey()) {
    console.warn(`[resurface] skipping ${project.slug}: Anthropic requested but key missing`);
    return { kind: "no-fit" };
  }
  const model = provider === "anthropic" ? reasoningModelHigh() : reasoningModel();

  const projectBlock = `## Project: ${project.name} (slug: ${project.slug})

${sanitizeUntrusted((project.readmeMd ?? "").slice(0, 8000), "PROJECT_README")}

${project.claudeMd ? sanitizeUntrusted(project.claudeMd.slice(0, 10000), "PROJECT_CLAUDE_MD") + "\n\n" : ""}Tech: ${project.techSummary ?? "(none)"}`;

  const outcomesBlock = `## Outcome goals to evaluate against
${eligible.map((g, i) => `${i + 1}. "${g.statement}" — source: ${g.source}, confidence: ${g.confidence}`).join("\n")}`;

  const repoBlock = `## Bookmarked repo: ${safety.meta.owner}/${safety.meta.name}

URL: https://github.com/${safety.meta.owner}/${safety.meta.name}
Bookmarked on: ${bookmarkedAt.toISOString().slice(0, 10)}
Stars: ${safety.meta.stars} · Forks: ${safety.meta.forks} · Age: ${safety.ageDays}d · Last push: ${safety.daysSincePush}d ago
Contributors: ${safety.contributorCount} · Language: ${safety.meta.language ?? "?"} · License: ${safety.meta.license ?? "?"}
Description: ${safety.meta.description ?? "(none)"}

Safety scan:
- risk level: ${safety.riskLevel}
- postinstall hooks: ${safety.postinstallHooks.join("; ") || "none"}
- suspicious patterns: ${safety.suspiciousPatterns.join(", ") || "none"}

${sanitizeUntrusted(safety.readmeMd.slice(0, 15000), "REPO_README")}`;

  let res;
  try {
    res = await chatCompletion(
      {
        provider,
        model,
        max_tokens: 4500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${RESURFACE_SYSTEM}\n\n${UNTRUSTED_CONTENT_RULE}` },
          { role: "user", content: `${projectBlock}\n\n${outcomesBlock}\n\n${repoBlock}` },
        ],
      },
      { timeoutMs: 180_000, retries: 2 }
    );
  } catch (e) {
    console.warn(`[resurface] LLM call failed for ${safety.meta.owner}/${safety.meta.name} → ${project.slug}`, e);
    return { kind: "error" };
  }

  const text = res.choices[0]?.message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { kind: "error" };

  try {
    const o = JSON.parse(m[0]);
    const rel = (o.relevance as string) ?? "general-awareness";
    if (rel !== "high" && rel !== "medium" && rel !== "general-awareness") return { kind: "error" };

    const matchedRaw = typeof o.matchedOutcome === "string" ? o.matchedOutcome.trim() : null;
    // Guard: LLM may hallucinate a paraphrased outcome. Reject anything that
    // isn't a verbatim match against one of the eligible statements.
    const matchedGoal = matchedRaw
      ? eligible.find((g) => g.statement === matchedRaw)
      : null;

    // No fit, by the LLM's own admission OR because it hallucinated an outcome
    // we didn't supply. Either way, treat as no-fit so the resurface_attempts
    // tombstone records 'no-fit' and we don't insert a noisy GA row.
    if (!matchedGoal || rel === "general-awareness") {
      return { kind: "no-fit" };
    }

    const writeup = scrubWriteup(String(o.writeup ?? "").trim());
    const summary = sanitizeMarkdown(String(o.summary ?? "").trim());
    const risks = sanitizeMarkdown(String(o.risks ?? "").trim());
    const whyUseful = sanitizeMarkdown(String(o.whyUseful ?? "").trim());
    const suggestedUse = sanitizeMarkdown(String(o.suggestedUse ?? "").trim());

    // Same injection-leak guard as score-targeted: drop if model echoed the
    // repo's README instructions back at us.
    const owner = safety.meta.owner;
    const leakReason =
      looksLikeInjectionLeak(writeup, owner) ||
      looksLikeInjectionLeak(summary, owner) ||
      looksLikeInjectionLeak(risks, owner);
    if (leakReason) {
      console.warn(`[resurface] dropping ${safety.meta.owner}/${safety.meta.name} → ${project.slug}: ${leakReason}`);
      return { kind: "error" };
    }

    // The resurface scorer is conservative: bookmarks resurfacing against an
    // INFERRED outcome must be unmistakable to land as medium/high. If the
    // LLM didn't already apply this stricter bar via the system prompt, we
    // enforce it here as a belt-and-suspenders guard.
    let finalRel: ProjectAssessment["relevance"] = rel as ProjectAssessment["relevance"];
    if (matchedGoal.source === "inferred" && (finalRel === "high" || finalRel === "medium")) {
      // Note: we don't downgrade further than what the LLM produced — we
      // trust its judgement when it already applied the stricter bar — but
      // we cap inferred resurfaces at 'medium'.
      if (finalRel === "high") finalRel = "medium";
    }

    const assessment: TargetedAssessment = {
      projectSlug: project.slug,
      relevance: finalRel,
      relevanceScore: Number(o.relevanceScore ?? 0),
      summary,
      whyUseful,
      suggestedUse,
      integrationApproach: (o.integrationApproach as ProjectAssessment["integrationApproach"]) ?? "n/a",
      risks,
      writeup,
      matchedOutcome: matchedGoal.statement,
      matchedOutcomeSource: matchedGoal.source,
      // OutcomeGoal allows 'low' confidence but resurface only fires on user
      // or high/medium — and only 'high' | 'medium' are valid values on the
      // TargetedAssessment, so narrow here.
      matchedOutcomeConfidence: (matchedGoal.confidence === "low" ? "medium" : matchedGoal.confidence) as "high" | "medium",
    };
    return { kind: "match", assessment };
  } catch (e) {
    console.warn(`[resurface] JSON parse failed for ${safety.meta.owner}/${safety.meta.name} → ${project.slug}`, e);
    return { kind: "error" };
  }
}

function scrubWriteup(s: string): string {
  const stripped = s
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\s*\*\*[^*]+\*\*\s*:?\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sanitizeMarkdown(stripped);
}
