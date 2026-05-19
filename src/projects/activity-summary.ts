// Activity summarizer. Takes the raw ProjectActivity blob from
// activity.ts and condenses it via an LLM call into a structured
// ProjectActivitySummary that downstream prompts (Stage 1, Stage 4,
// reasonAboutRepo) can consume directly.
//
// Per locked principles:
//   - Sensitive projects route through Anthropic (fail-closed when key
//     missing); non-sensitive go through the user's primary slot.
//   - Output is JSON-only with strict shape coercion so prompt drift
//     can't break downstream consumers.

import { chatCompletion, hasAnthropicKey, reasoningModelHigh, triageModel } from "../analyzer/llm";
import type { ProjectActivity } from "./activity";

export const ACTIVITY_PROMPT_VERSION = "v1";

export type ProjectActivitySummary = {
  // 1-3 sentences. Concrete: name the actual feature / module / problem
  // the user has been working on. Empty string when the project is
  // dormant.
  summary: string;
  // 3-6 short tags ("websocket telemetry", "auth refactor"). Used both
  // for the LLM downstream and for UI chips.
  themes: string[];
  // File paths the dev has touched most. Up to 10. Helps the LLM
  // ground writeups in real files.
  topFiles: string[];
  // "active" when there are recent commits, "dormant" when there aren't.
  // Drives whether downstream prompts include the current-work block at
  // all.
  state: "active" | "dormant";
  // For UI: how many days since the last commit, or null.
  daysSinceLastCommit: number | null;
  // Metadata for cache-invalidation + display.
  generatedAt: string; // ISO
  promptVersion: string;
};

const SYSTEM_PROMPT = `You summarize what a developer has been actively building on a project, based on raw signals: recent commit subjects, currently-touched files, open pull requests, and TODO/FIXME comments clustered by directory.

Output ONE JSON object:
{
  "summary": "1-3 short sentences naming the actual feature or refactor in progress. Be specific. Use real file names or function names that appear in commits/PRs. 'Working on auth flow' is too vague; 'Replacing the cookie auth with Firebase OAuth in src/auth/' is right.",
  "themes": ["3-6 short tags, lowercase, kebab-case or normal English. e.g. 'websocket telemetry', 'auth refactor', 'pgvector migration'"]
}

Rules:
- If there's no real signal (no commits, no PRs, no TODOs), return {"summary": "", "themes": []}.
- Don't restate the project's general purpose. The reader already knows what the project IS. They want to know what it's DOING THIS PERIOD.
- Don't pad. If there's only one theme, return one theme. Don't invent.
- No em-dashes (—) or en-dashes (–). Use commas or sentence breaks.
- Lead with substance. No setup phrases like "The developer has been...".`;

function buildUserPrompt(a: ProjectActivity, projectName: string, projectSlug: string): string {
  const parts: string[] = [`Project: ${projectName} (${projectSlug})`];
  if (a.branch) parts.push(`Current branch: ${a.branch}`);
  if (a.daysSinceLastCommit !== null) {
    parts.push(`Days since last commit: ${a.daysSinceLastCommit}`);
  }
  if (a.commits.length > 0) {
    const lines = a.commits.slice(0, 40).map((c) => `  ${c.isoDate.slice(0, 10)}  ${c.subject.slice(0, 140)}`);
    parts.push(`Recent commit subjects (most recent first):\n${lines.join("\n")}`);
  }
  if (a.topChangedFiles.length > 0) {
    const lines = a.topChangedFiles.slice(0, 15).map((f) => `  ${f.path} (${f.changes} changes)`);
    parts.push(`Most-touched files (last 30 days):\n${lines.join("\n")}`);
  }
  if (a.openPRs.length > 0) {
    const lines = a.openPRs.slice(0, 8).map((p) => {
      const body = p.bodyExcerpt ? ` — ${p.bodyExcerpt.replace(/\s+/g, " ").slice(0, 120)}` : "";
      return `  #${p.number}  ${p.title}${body}`;
    });
    parts.push(`Open pull requests:\n${lines.join("\n")}`);
  }
  if (a.todoClusters.length > 0) {
    const lines = a.todoClusters.slice(0, 6).map((c) => {
      const ex = c.examples[0]?.slice(0, 100) ?? "";
      return `  ${c.dir}  (${c.count} TODOs; e.g. "${ex}")`;
    });
    parts.push(`TODO/FIXME clusters:\n${lines.join("\n")}`);
  }
  parts.push("\nReturn JSON: {summary, themes}");
  return parts.join("\n\n");
}

export type SummarizerOpts = {
  sensitivity?: "low" | "high";
};

export async function summariseActivity(
  activity: ProjectActivity,
  projectName: string,
  projectSlug: string,
  opts: SummarizerOpts = {},
): Promise<ProjectActivitySummary | null> {
  // No signal at all → return a dormant summary directly. Skips the LLM
  // call when there's nothing to summarise, which is the common case for
  // archived / vacation-mode projects.
  const hasSignal = activity.commits.length > 0 || activity.openPRs.length > 0 || activity.todoClusters.length > 0;
  if (!hasSignal) {
    return {
      summary: "",
      themes: [],
      topFiles: [],
      state: "dormant",
      daysSinceLastCommit: activity.daysSinceLastCommit,
      generatedAt: new Date().toISOString(),
      promptVersion: ACTIVITY_PROMPT_VERSION,
    };
  }

  // Sensitivity gate: high-sens projects route through Anthropic (the
  // sensitive slot). Same fail-closed pattern as Stage 1 / Stage 4.
  let model: string;
  let provider: "deepseek" | "anthropic" | undefined;
  if (opts.sensitivity === "high") {
    if (!hasAnthropicKey()) {
      console.warn(`[activity-summary] ${projectSlug}: high-sensitivity but no Anthropic key — skipping`);
      return null;
    }
    model = reasoningModelHigh();
    provider = "anthropic";
  } else {
    model = triageModel();
    provider = "deepseek";
  }

  let raw = "";
  try {
    const res = await chatCompletion(
      {
        provider,
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(activity, projectName, projectSlug) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 600,
      },
      { timeoutMs: 60_000, retries: 1 },
    );
    raw = res.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    console.warn(`[activity-summary] ${projectSlug}: LLM call failed: ${(e as Error).message}`);
    return null;
  }

  return coerce(raw, activity, projectSlug);
}

function coerce(raw: string, activity: ProjectActivity, projectSlug: string): ProjectActivitySummary | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    console.warn(`[activity-summary] ${projectSlug}: no JSON in LLM response (len=${raw.length})`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch (e) {
    console.warn(`[activity-summary] ${projectSlug}: JSON parse failed: ${(e as Error).message}`);
    return null;
  }
  const obj = parsed as { summary?: unknown; themes?: unknown };
  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 600) : "";
  const themes = Array.isArray(obj.themes)
    ? obj.themes
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length >= 2 && t.length <= 60)
        .slice(0, 6)
    : [];
  // topFiles aren't generated by the LLM; we derive directly from the
  // probe so the UI can show real-grounded paths and the prompt can quote
  // them without paying tokens twice. Keep top 10.
  const topFiles = activity.topChangedFiles.slice(0, 10).map((f) => f.path);

  return {
    summary,
    themes,
    topFiles,
    state: "active",
    daysSinceLastCommit: activity.daysSinceLastCommit,
    generatedAt: new Date().toISOString(),
    promptVersion: ACTIVITY_PROMPT_VERSION,
  };
}

// Cache-invalidation predicate. Refresh if:
//   - no cached activity at all, OR
//   - the prompt version bumped (incompatible cached output), OR
//   - the git HEAD has moved (real work happened since), OR
//   - the cache is older than 24h (catches dormant projects that didn't
//     commit but might have new PRs or TODOs).
const STALENESS_MS = 24 * 60 * 60 * 1000;
export function needsActivityRefresh(args: {
  activityJson: string | null;
  activityGeneratedAt: Date | null;
  activityHeadSha: string | null;
  currentHeadSha: string | null;
}): { regen: boolean; reason: string } {
  if (!args.activityJson) return { regen: true, reason: "no-activity" };
  let parsed: ProjectActivitySummary | null = null;
  try {
    parsed = JSON.parse(args.activityJson) as ProjectActivitySummary;
  } catch {
    return { regen: true, reason: "cache-corrupt" };
  }
  if (parsed.promptVersion !== ACTIVITY_PROMPT_VERSION) {
    return { regen: true, reason: "prompt-version-bumped" };
  }
  if (args.currentHeadSha && args.activityHeadSha !== args.currentHeadSha) {
    return { regen: true, reason: "head-moved" };
  }
  if (!args.activityGeneratedAt) return { regen: true, reason: "no-timestamp" };
  const ageMs = Date.now() - args.activityGeneratedAt.getTime();
  if (ageMs > STALENESS_MS) return { regen: true, reason: "stale" };
  return { regen: false, reason: "fresh" };
}
