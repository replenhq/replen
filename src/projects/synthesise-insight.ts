// LLM synthesizer for Initiative #3. Takes a programmatically-identified
// cluster of matches plus enough match context to ground the writeup,
// and asks the model to name the pattern + give the user a concrete
// next step.
//
// One LLM call per cluster. The clustering layer caps the number of
// clusters per run (MAX_INSIGHTS_PER_RUN) so total cost is bounded.

import { chatCompletion, hasAnthropicKey, reasoningModel, reasoningModelHigh, LlmQuotaError } from "../analyzer/llm";
import { sanitizeMarkdown } from "../lib/markdown-sanitize";
import { scrubBannedVocab } from "../analyzer/score-targeted";
import type { Cluster } from "./synthesis-cluster";

// Match fields the synthesizer needs to ground its writeup. Kept minimal
// so callers can pass the same shape they already have from the run's
// match query (no extra DB hop).
export type SynthesisMatch = {
  id: number;
  repoFullName: string;       // owner/name
  repoUrl: string | null;
  projectSlug: string | null; // null = general-feed (no project)
  relevance: string;          // 'high' | 'medium' | 'general-awareness'
  relevanceScore: number;
  summary: string | null;
  whyUseful: string | null;
  suggestedUse: string | null;
  integrationApproach: string | null;
  matchedOutcome: string | null;
  discoveryMode: string | null;
};

// Project context the synthesizer can reference. Optional — clusters
// can synthesize meaningfully without project context, but adding the
// active themes makes the writeup feel grounded.
export type SynthesisProjectContext = {
  slug: string;
  name: string;
  purpose: string | null;            // from project summary
  currentlyBuilding: string | null;  // activity.summary if active
};

export type SynthesisInput = {
  cluster: Cluster;
  matches: SynthesisMatch[];        // ordered by relevanceScore desc
  projects: SynthesisProjectContext[]; // projects touched by this cluster
  // Pre-resolved by resolveClusterProvider — caller honors per-project
  // llmProvider overrides so a user can opt sensitive projects into
  // DeepSeek without paying for an Anthropic key.
  provider: "deepseek" | "anthropic";
};

export type SynthesisOutput = {
  title: string;       // 1 line, ≤90 chars
  bodyMd: string;      // 150-350 words. Markdown allowed.
  themes: string[];    // 1-6 short tags pulled from the writeup
};

const SYSTEM_PROMPT = `You are Replen's synthesis writer. The user runs an OSS-digest pipeline that surfaces individual repos for individual projects. Once enough matches accumulate in a single run, you spot the pattern across them and write a single insight the user can act on.

You will be given:
  - A cluster of matches (3-10 repos) that share a topic, span multiple of the user's projects, or share the same integration approach.
  - The cluster's "kind": "topic", "cross-project", or "approach".
  - Brief context on the user's projects.

Your job is to write a meta-insight: what is the pattern these matches reveal, and what should the user DO about it.

INSIGHT KINDS:

  topic: 3+ matches share a meaningful topic / technical theme. Name the theme precisely (not "AI tools", but "agent permission sandboxing" or "BM25 hybrid retrieval"). Then either:
    (a) tell the user the canonical implementation or convergence point across the matches, OR
    (b) call out what they DON'T have in their project that these repos all do.

  cross-project: a theme appears in matches landing on ≥2 of the user's distinct projects. Frame this as: "you have N projects that could all use pattern X this week" with concrete callouts per project.

  approach: 3+ matches share the same integrationApproach (e.g. "cleanroom-rebuild", "cherry-pick", "depend-on-it"). The insight here is meta: "you've gotten 5 cleanroom-rebuild suggestions this week, here's the common shape, here's what to centralize."

WRITING STYLE:
  - Lead with substance. No "It's worth noting" / "I observe" / "Interestingly" openers.
  - Reference repos by their canonical owner/name. The bodyMd may render markdown links to their URLs.
  - Be specific. Name files, name patterns, name commands.
  - No em dashes (—) or en dashes (–). Use commas or sentence breaks.
  - No "outcome" or "goal" words. Use "need", "pain", "problem", or just describe the thing.
  - 150-350 words for the body. Three short paragraphs works well: pattern, evidence, next step.
  - Title is a single line, no trailing punctuation, ≤90 chars. State the finding, not the topic.

OUTPUT JSON ONLY:
{
  "title": "string, ≤90 chars",
  "bodyMd": "markdown, 150-350 words",
  "themes": ["tag", "tag", ...]  // 1-6 short kebab-case tags
}`;

// One LLM call. Returns null on parse / quota-recoverable failure;
// throws LlmQuotaError so the run-level catch can pause the pipeline.
export async function synthesiseInsight(input: SynthesisInput): Promise<SynthesisOutput | null> {
  const provider = input.provider;
  if (provider === "anthropic" && !hasAnthropicKey()) {
    console.warn(`[synth] cluster kind=${input.cluster.kind} matches=${input.cluster.matchIds.length}: provider=anthropic but no Anthropic key, skipping`);
    return null;
  }
  const model = provider === "anthropic" ? reasoningModelHigh() : reasoningModel();

  const userMessage = buildUserPrompt(input);

  let raw = "";
  try {
    const res = await chatCompletion(
      {
        provider,
        model,
        max_tokens: 1400,
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
    console.warn(`[synth] cluster kind=${input.cluster.kind}: LLM call failed: ${(e as Error).message}`);
    return null;
  }

  return coerce(raw, input);
}

function buildUserPrompt(i: SynthesisInput): string {
  const parts: string[] = [];
  parts.push(`## Cluster`);
  parts.push(`Kind: ${i.cluster.kind}`);
  if (i.cluster.approach) parts.push(`Shared integration approach: ${i.cluster.approach}`);
  if (i.cluster.sharedTokens.length > 0) {
    parts.push(`Shared signals: ${i.cluster.sharedTokens.slice(0, 12).join(", ")}`);
  }
  if (i.cluster.primaryProjectSlug) {
    parts.push(`Primary project this lands in: ${i.cluster.primaryProjectSlug}`);
  }

  if (i.projects.length > 0) {
    parts.push(``);
    parts.push(`## User's projects in this cluster`);
    for (const p of i.projects) {
      parts.push(`### ${p.name} (${p.slug})`);
      if (p.purpose) parts.push(`Purpose: ${p.purpose}`);
      if (p.currentlyBuilding) parts.push(`Currently building: ${p.currentlyBuilding}`);
    }
  }

  parts.push(``);
  parts.push(`## Matches in this cluster (${i.matches.length})`);
  for (const m of i.matches) {
    parts.push(`### ${m.repoFullName}${m.projectSlug ? ` → ${m.projectSlug}` : ""}`);
    parts.push(`Relevance: ${m.relevance} (${m.relevanceScore})`);
    if (m.discoveryMode) parts.push(`Discovery: ${m.discoveryMode}`);
    if (m.matchedOutcome) parts.push(`Matched need: ${m.matchedOutcome}`);
    if (m.summary) parts.push(`Summary: ${m.summary}`);
    if (m.whyUseful) parts.push(`Why useful: ${m.whyUseful}`);
    if (m.suggestedUse) parts.push(`Suggested use: ${m.suggestedUse}`);
    if (m.integrationApproach && m.integrationApproach !== "n/a") {
      parts.push(`Integration approach: ${m.integrationApproach}`);
    }
    if (m.repoUrl) parts.push(`URL: ${m.repoUrl}`);
  }

  parts.push(``);
  parts.push(`Return JSON as specified. Title must be ≤90 chars. Body must be 150-350 words of markdown.`);
  return parts.join("\n");
}

function coerce(raw: string, input: SynthesisInput): SynthesisOutput | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    console.warn(`[synth] cluster kind=${input.cluster.kind}: no JSON in LLM response`);
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m[0]) as Record<string, unknown>;
  } catch (e) {
    console.warn(`[synth] cluster kind=${input.cluster.kind}: JSON parse failed: ${(e as Error).message}`);
    return null;
  }

  const rawTitle = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const rawBody = typeof parsed.bodyMd === "string" ? parsed.bodyMd.trim() : "";
  if (rawTitle.length === 0 || rawBody.length === 0) {
    console.warn(`[synth] cluster kind=${input.cluster.kind}: empty title/body`);
    return null;
  }

  const title = scrubBannedVocab(sanitizeMarkdown(rawTitle)).slice(0, 110);
  const bodyMd = scrubBannedVocab(rawBody);

  let themes: string[] = [];
  if (Array.isArray(parsed.themes)) {
    themes = (parsed.themes as unknown[])
      .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
      .filter((t) => t.length > 0 && t.length <= 40)
      .slice(0, 6);
  }

  return { title, bodyMd, themes };
}
