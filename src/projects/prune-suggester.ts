// Prune suggester (Initiative #2). For each project's stale/dead/archived
// dependency, asks an LLM whether to drop, replace, or keep, with a
// concrete writeup the user can act on. Inserts matches with
// discoveryMode='prune' so they surface in the feed alongside scouted /
// discovered / re-checked matches.
//
// Cadence: this runs every pipeline tick BUT the LLM verdict is cached
// per (project, dep) keyed on the dep's verdict bucket — so a 'stale'
// dep only re-prompts the LLM if its verdict changes (e.g. dep gets
// archived, or comes back to life with a new release).

import { chatCompletion, hasAnthropicKey, reasoningModel, reasoningModelHigh, LlmQuotaError } from "../analyzer/llm";
import { sanitizeMarkdown } from "../lib/markdown-sanitize";
import type { UpstreamHealth } from "./dep-health";
import type { ProjectActivitySummary } from "./activity-summary";
import { scrubBannedVocab } from "../analyzer/score-targeted";

export type PruneVerdict = {
  // Action the LLM recommends. "keep" means "this dep is stale but you
  // still need it" (e.g. it's core infrastructure with no live alternative).
  action: "drop" | "replace" | "keep";
  // Suggested replacement when action="replace". Null otherwise. The
  // ecosystem matches the targeted dep's ecosystem.
  replacementName: string | null;
  // Free-form prose: 150-400 words explaining the why + the how.
  writeup: string;
  // Structured fields for the feed card.
  summary: string;
  whyUseful: string;
  suggestedUse: string;
  risks: string;
  // 0-100 urgency. 80+ = act now (active vuln / blocking dead dep),
  // 50-79 = should fix this quarter, 25-49 = FYI / low priority, 0-24
  // = the LLM thinks this is a false alarm (rarely fires when input
  // is genuinely stale).
  score: number;
};

const SYSTEM_PROMPT = `You are advising a software engineer on a dependency that's been flagged as stale, dead, or archived. The engineer's project context, their CURRENT active work, and the dep's health signals are provided.

Decide ONE action: "drop", "replace", or "keep".

  drop:    Remove the dep entirely. Used when the dep is no longer needed,
           when a built-in language feature now covers it (e.g. lodash
           helpers superseded by ES2022+), or when removal is the cleanest
           path with no like-for-like replacement.

  replace: Recommend a specific actively-maintained alternative. Used when
           the original capability is still needed but a better library
           has converged in the ecosystem. Name the replacement by its
           canonical package name (e.g. "date-fns", "axios", "vitest").
           ONLY recommend a replacement you're confident still exists and
           is actively maintained. Don't invent.

  keep:    Despite being stale, this dep should stay. Used when the dep
           is core infrastructure with no live alternative, or when the
           "stale" signal is misleading (e.g. a small but stable library
           that just doesn't need updates). Be honest, this happens a lot.

WRITING STYLE:
  - No em dashes (—) or en dashes (–). Use commas or sentence breaks.
  - No "outcome" or "goal" words.
  - Lead with the substance. No "It is worth noting that..." openers.
  - Mix paragraph lengths. Punchy first line, then 2-3 sentence groups.

SCORE BANDS (urgency, not fit):
  80-100  blocking. archived deps, deps with known CVEs, deps the engineer's
          current work depends on heavily that ALSO got archived.
  50-79   should fix this quarter. Stale-but-functional, modern alternative
          available, replacement is mechanical.
  25-49   FYI. Stale but still works fine. No urgent action needed.
  0-24    false alarm. The "stale" verdict is misleading and the dep should
          stay. Pair with action="keep".

Output JSON only:
{
  "action": "drop" | "replace" | "keep",
  "replacementName": "<name>" | null,
  "summary": "1 sentence: what the dep is + the verdict in plain English",
  "whyUseful": "1 sentence: the single reason this matters to act on",
  "suggestedUse": "1 sentence: the concrete first command/action",
  "risks": "1 sentence: licence / behavioural-difference / migration cost",
  "writeup": "150-400 word writeup explaining the why and the how. Reference the project's actual current work where relevant (themes / files). If recommending a replacement, give 1-2 sentences on what changes during the migration.",
  "score": 0-100
}`;

export type PruneInput = {
  projectName: string;
  projectSlug: string;
  projectSummary: string | null; // 1-paragraph project description
  activity: ProjectActivitySummary | null;
  dep: { name: string; version: string; ecosystem: string };
  health: UpstreamHealth;
  sensitivity: "low" | "high";
};

export async function suggestPrune(input: PruneInput): Promise<PruneVerdict | null> {
  // Sensitivity gate.
  let provider: "deepseek" | "anthropic";
  if (input.sensitivity === "high") {
    if (!hasAnthropicKey()) {
      console.warn(`[prune] ${input.projectSlug}/${input.dep.name}: high-sensitivity but no Anthropic key — skipping`);
      return null;
    }
    provider = "anthropic";
  } else {
    provider = "deepseek";
  }
  const model = provider === "anthropic" ? reasoningModelHigh() : reasoningModel();

  const userMessage = buildUserPrompt(input);
  let raw = "";
  try {
    const res = await chatCompletion(
      {
        provider,
        model,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      },
      { timeoutMs: 90_000, retries: 1 },
    );
    raw = res.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    if (e instanceof LlmQuotaError) throw e;
    console.warn(`[prune] ${input.projectSlug}/${input.dep.name}: LLM call failed: ${(e as Error).message}`);
    return null;
  }

  return coerce(raw, input);
}

function buildUserPrompt(i: PruneInput): string {
  const parts: string[] = [
    `## Project: ${i.projectName} (${i.projectSlug})`,
    i.projectSummary ? `Project description: ${i.projectSummary}` : `Project description: (not yet summarised)`,
  ];
  if (i.activity && i.activity.state === "active" && i.activity.summary) {
    parts.push(`## Currently building`);
    parts.push(i.activity.summary);
    if (i.activity.themes.length > 0) {
      parts.push(`Themes: ${i.activity.themes.join(", ")}`);
    }
    if (i.activity.topFiles.length > 0) {
      parts.push(`Recent files: ${i.activity.topFiles.slice(0, 6).join(", ")}`);
    }
  }
  parts.push(`## Flagged dependency`);
  parts.push(`Name: ${i.dep.name}`);
  parts.push(`Ecosystem: ${i.dep.ecosystem}`);
  parts.push(`Constraint in the manifest: ${i.dep.version}`);
  parts.push(`Upstream GitHub: ${i.health.githubFullName ?? "(unresolved)"}`);
  parts.push(`Verdict: ${i.health.verdict} (${i.health.verdictReason})`);
  if (i.health.daysSinceLastPush !== null) {
    parts.push(`Days since upstream's last push: ${i.health.daysSinceLastPush}`);
  }
  if (i.health.stars !== null) {
    parts.push(`Stars: ${i.health.stars}`);
  }
  parts.push(`\nReturn JSON as specified.`);
  return parts.join("\n");
}

function coerce(raw: string, input: PruneInput): PruneVerdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    console.warn(`[prune] ${input.projectSlug}/${input.dep.name}: no JSON in LLM response`);
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m[0]) as Record<string, unknown>;
  } catch (e) {
    console.warn(`[prune] ${input.projectSlug}/${input.dep.name}: JSON parse failed: ${(e as Error).message}`);
    return null;
  }
  const action = String(parsed.action ?? "keep");
  if (action !== "drop" && action !== "replace" && action !== "keep") {
    console.warn(`[prune] ${input.projectSlug}/${input.dep.name}: invalid action: ${action}`);
    return null;
  }
  const replacementName = typeof parsed.replacementName === "string" && parsed.replacementName.trim().length > 0
    ? parsed.replacementName.trim()
    : null;
  return {
    action,
    replacementName,
    writeup: scrubBannedVocab(String(parsed.writeup ?? "").trim()),
    summary: scrubBannedVocab(sanitizeMarkdown(String(parsed.summary ?? "").trim())),
    whyUseful: scrubBannedVocab(sanitizeMarkdown(String(parsed.whyUseful ?? "").trim())),
    suggestedUse: scrubBannedVocab(sanitizeMarkdown(String(parsed.suggestedUse ?? "").trim())),
    risks: scrubBannedVocab(sanitizeMarkdown(String(parsed.risks ?? "").trim())),
    score: Math.max(0, Math.min(100, Number(parsed.score ?? 0))),
  };
}

// Map the action + score into a relevance tier consistent with the rest
// of the feed. "drop" + "replace" with score >= 50 are medium (worth
// taking action on). All others are general-awareness (FYI / keep).
export function tierForVerdict(v: PruneVerdict): "high" | "medium" | "general-awareness" {
  if (v.action === "keep") return "general-awareness";
  if (v.score >= 80) return "high";
  if (v.score >= 50) return "medium";
  return "general-awareness";
}

// Map the action to the existing integrationApproach enum so the feed's
// integration-approach badge renders meaningfully on prune matches.
// "drop" has no integration; we render it as "n/a" (the badge hides).
// "replace" implies depending on the replacement: "depend-on-it".
// "keep" is "n/a" (the dep stays as-is).
export function approachForVerdict(v: PruneVerdict): string {
  if (v.action === "replace") return "depend-on-it";
  return "n/a";
}
