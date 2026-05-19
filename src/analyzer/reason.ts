import { chatCompletion, hasAnthropicKey, reasoningModel, reasoningModelHigh, triageModel } from "./llm";
import type { SafetyReport } from "../scanner/safety";
import type { LocalProject } from "../projects/loader";
import { sanitizeUntrusted, UNTRUSTED_CONTENT_RULE, looksLikeInjectionLeak } from "./guards";
import { sanitizeMarkdown } from "../lib/markdown-sanitize";
import { errorMsg } from "../lib/error-msg";
import { scrubBannedVocab } from "./score-targeted";

export type ProjectAssessment = {
  projectSlug: string;
  relevance: "high" | "medium" | "general-awareness";
  relevanceScore: number;
  summary: string;
  whyUseful: string;
  suggestedUse: string;
  integrationApproach: "cherry-pick" | "vendor" | "cleanroom-rebuild" | "depend-on-it" | "n/a";
  risks: string;
  writeup: string;
};

export type ReasoningOutput = {
  oneLiner: string;
  safetyNotes: string;
  perProject: ProjectAssessment[];
};

// Pass A: shortlist

const SHORTLIST_SYSTEM = `You are deciding which of a software engineer's projects a newly-discovered open-source repo could plausibly plug into.

Rules:
- Be selective. Most repos won't fit ANY specific project. Returning [] is the right answer when nothing fits.
- Return at most 3 project slugs, ranked by strength of fit.
- If the repo is broadly interesting but not project-specific (a useful library/tool/idea that doesn't slot into anything), include the special slug "_general" in the list.
- Otherwise omit "_general".

Output JSON ONLY: {"shortlist": ["slug1","slug2"], "oneLiner": "<1 sentence on what the repo is>"}`;

async function shortlistProjects(safety: SafetyReport, projects: LocalProject[]): Promise<{ slugs: string[]; oneLiner: string }> {
  const projectLines = projects
    .map((p) => {
      const tech = (p.techSummary ?? "").split("\n")[0].slice(0, 120);
      const firstLine = (p.readmeMd ?? "").split("\n").find((l) => l.trim() && !l.startsWith("#"))?.slice(0, 220) ?? "";
      return `- ${p.slug}${p.active ? " [active]" : ""}: ${firstLine} (${tech})`;
    })
    .join("\n");

  const userText = `Candidate repo: ${safety.meta.owner}/${safety.meta.name}
Description: ${safety.meta.description ?? "(none)"}
Language: ${safety.meta.language ?? "?"} · License: ${safety.meta.license ?? "?"}

${sanitizeUntrusted(safety.readmeMd.slice(0, 4000), "REPO_README")}

Available projects:
${projectLines}`;

  const res = await chatCompletion(
    {
      model: triageModel(),
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${SHORTLIST_SYSTEM}\n\n${UNTRUSTED_CONTENT_RULE}` },
        { role: "user", content: userText },
      ],
    },
    { timeoutMs: 60_000, retries: 2 }
  );

  const text = res.choices[0]?.message?.content ?? "{}";
  try {
    const o = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const slugs = (Array.isArray(o.shortlist) ? o.shortlist : []).map(String).slice(0, 4);
    return { slugs, oneLiner: String(o.oneLiner ?? "") };
  } catch {
    return { slugs: [], oneLiner: "" };
  }
}

// Pass B: deep writeup for a single (project, repo) pair

const DEEP_SYSTEM = `You are a senior engineer writing a scoping note about a newly-discovered open-source repo and what value (if any) your colleague's specific project can extract from it.

Value comes in multiple forms — and "integration" is only one. A great repo for this user might:
- Integrate end-to-end (drop-in dependency, or vendored adaptation).
- Have a couple of components worth cherry-picking, ignore the rest.
- Offer a clever ALGORITHM, DATA MODEL, ARCHITECTURE, or UX move worth reimplementing IN-HOUSE (idea extraction — often higher leverage than integration because it bypasses the licence + dep-tree burden).
- Be a competitor with features worth re-building.

"Doesn't integrate cleanly" is NOT the same as "no value to surface." Mining a repo for borrowable ideas counts. Only when integration AND idea-extraction are both weak (pure keyword overlap, no transferable concept) should you drop into the lowest band.

WRITE IN PLAIN PROSE. NO markdown headers (no #, ##, ###). NO bold "Summary:" or "Risks:" labels. Use natural paragraphs separated by BLANK LINES (\\n\\n in the JSON string) and inline numbered lists only where it helps structure.

PARAGRAPH BREAKS ARE REQUIRED. The intro, the bridge sentence, each numbered plug point, and the scoping paragraph must all be separated by a blank line (two newlines, \\n\\n).

WRITING STYLE — applies to writeup, summary, whyUseful, suggestedUse, risks:
- NO em dashes (—). NO en dashes (–). Use a hyphen (-), comma, or sentence break instead. Hyphens BETWEEN words (e.g. "drop-in", "cherry-pick") are fine.
- Vary paragraph lengths. Some sentences stand alone as a single-line paragraph; others group 2-3 sentences together. Avoid uniform walls of text.
- Aim for visual rhythm: a punchy one-liner, then a longer paragraph, then another short one. Scannable.
- Lead with the substance, not setup phrases ("It is worth noting that...", "This repository provides...").

Structure your note like this:

(paragraph 1) Open with 1-2 sentences on what the repo actually is - what it does, the tech split (e.g. hardware vs software, Rust core vs Python bindings), license, and any obvious constraints.

(paragraph 2) Bridge into project fit with a natural sentence that names <PROJECT_NAME> and signals how many plug points follow. Read like a senior engineer pointing a colleague at a useful library — concise, file-path-specific, no product-brief vocabulary.

FORBIDDEN openers (over-used / read as templated):
- "For <PROJECT_NAME> specifically, there are N concrete plug points where it earns its place. Listed in increasing ambition:"
- Any opener that uses the literal word "outcome" or quotes an outcome phrase.

BANNED VOCABULARY — the following words MUST NOT appear anywhere in the writeup body, summary, whyUseful, suggestedUse, or risks:
- "outcome", "outcomes"
- "goal", "goals" (use "need", "what <PROJECT_NAME> needs", or just describe directly)
- "the outcome 'X'", "the goal 'X'" (any quoted framing of the project's intent)

If you find yourself wanting to write "for the outcome X" or "for the X goal", rephrase as "for <PROJECT_NAME>'s <whatever it actually is>" or just talk about the concrete need directly.

Acceptable shapes (don't copy verbatim, rotate naturally):
- "<PROJECT_NAME> has N clean integration paths here, smallest first:"
- "Where <PROJECT_NAME> would actually use this: N specific surfaces, ordered by effort."
- "Three places this plugs into <PROJECT_NAME>, in order of payoff:" (only if N=3)
- "The one integration <PROJECT_NAME> needs from this is <X>." (when N=1; collapse the numbered list into a single paragraph)
- "Five points where <PROJECT_NAME> gains from this, from quickest win to deepest cut:" (when N=5)
- "<PROJECT_NAME> gains N things from this, listed cheapest first:"
- "Two surfaces in <PROJECT_NAME> change shape if this lands:" (when N=2)
- "Where this earns its place in <PROJECT_NAME>: N specific subsystems."

N is the number of plug points the repo GENUINELY supports for THIS project. Could be 1 (one perfect drop-in, no need to invent more — just write a single paragraph after the bridge, no list). Could be 2, 3, 5, 7 — whatever the repo honestly justifies. Do NOT pad to hit a count. Do NOT trim a real fit to feel "balanced". Calibrate by integration value, not by aesthetic shape.

(numbered list, OR a single paragraph if N=1) For each plug point, write a short imperative title (e.g. "1. New Tier-A sensor source.") followed by 2-5 sentences of concrete how-to. NAME THE SUBSYSTEM in <PROJECT_NAME> where it'd slot in — refer to the actual module, file path, or service the project already has. Be specific about behaviour gained.

(closing paragraph) Scoping. Identify the smallest viable first slice — which plug point is fastest, what does it depend on, rough time estimate (hours/days). If items build on each other, say so.

Cardinal rules:
- Reference the user's project's actual components by name (services, modules, files) - pull these from their CLAUDE.md or README context provided. If you don't have specifics, use generic-but-grounded references (e.g. "your image-processing layer") rather than empty filler.
- No filler phrases like "could be useful for", "interesting potential", "worth exploring". Every sentence must carry concrete information.
- License / star count / risk goes in the metadata fields, NOT in the writeup body.
- 400-900 words. Aim for substance not length.

If you can't justify even one concrete plug point AND can't name a specific borrowable idea or pattern, set relevance="general-awareness" with score under 25 and write a single sentence saying so — these get dropped before reaching the user.

If you can name ONE idea worth lifting (algorithm, data model, UX pattern, framing) even though the repo doesn't integrate, that's a medium-tier result (50-79 range, integrationApproach="cleanroom-rebuild"). Don't grade these as general-awareness just because the code itself doesn't transfer.

Also fill the structured fields:
- relevance:
    "high"               → integrate this week (whole repo OR multiple substantial cherry-picks)
    "medium"             → real integration with adaptation, OR 1-2 specific ideas/patterns worth reimplementing in-house
    "general-awareness"  → loose conceptual overlap, worth knowing exists but no clear action
- relevanceScore 0-100. Calibration:
    80-100: clear high-impact value (integration OR multiple borrowable patterns)
    50-79:  solid medium value (integrate-with-adaptation, OR 1-2 specific ideas to rebuild in-house)
    25-49:  loose conceptual link; worth a glance but no action
    0-24:   pure keyword overlap; gets dropped
- summary: 1 sentence on what the repo is (the "what" only, no fit assessment)
- whyUseful: 1 sentence naming the single most valuable thing (plug point OR idea to lift)
- suggestedUse: 1 sentence - the concrete first action (file to create, function to replace, OR idea to study + rebuild)
- integrationApproach:
    "depend-on-it"      → import directly
    "cherry-pick"       → lift specific files / functions into the project
    "vendor"            → copy in-tree, adapt
    "cleanroom-rebuild" → take the IDEA, write your own (no code transferred)
    "n/a"               → nothing to integrate or rebuild
- risks: 1 sentence - license issues, abandoned, single maintainer, weird hooks, recent star spike, anything to actually worry about

Output JSON ONLY:
{
  "relevance": "...",
  "relevanceScore": 0,
  "summary": "...",
  "whyUseful": "...",
  "suggestedUse": "...",
  "integrationApproach": "...",
  "risks": "...",
  "writeup": "<the prose scoping note as described above>"
}`;

// Extra discovery-context hints we want the LLM to see when judging fit.
// Currently just trending window breadth (gh-trending); kept extensible so
// we can fold in HN/Reddit comment signals later without another plumbing
// round.
export type DiscoveryContext = {
  /** Windows on which a gh-trending repo appeared. e.g. ["daily","weekly","monthly"] */
  trendingWindows?: string[];
};

async function deepWriteup(
  safety: SafetyReport,
  project: LocalProject | null,
  oneLiner: string,
  discovery: DiscoveryContext | null,
): Promise<ProjectAssessment | null> {
  const isGeneral = !project;
  const projectName = project?.name ?? "_general";

  // User docs are trusted but still wrapped so the model can't confuse them
  // with system instructions; candidate README is hostile by default.
  const projectBlock = project
    ? `## Project: ${project.name} (slug: ${project.slug})

${sanitizeUntrusted((project.readmeMd ?? "").slice(0, 8000), "PROJECT_README")}

${project.claudeMd ? sanitizeUntrusted(project.claudeMd.slice(0, 10000), "PROJECT_CLAUDE_MD") + "\n\n" : ""}Tech: ${project.techSummary ?? "(none)"}`
    : `## Target: _general (no specific project - write a general-awareness note)`;

  // Trending-window hint: when a repo surfaced via gh-trending we know
  // whether it appeared on daily, weekly, monthly, or some combination.
  // All-three is a stronger signal than a single-day spike — pass that to
  // the LLM so it can weight breadth alongside stars/age. Omit the line
  // entirely for non-trending sources so it doesn't add noise.
  const trendingLine = renderTrendingSignal(discovery?.trendingWindows);

  const repoBlock = `## Candidate repo: ${safety.meta.owner}/${safety.meta.name}

URL: https://github.com/${safety.meta.owner}/${safety.meta.name}
Stars: ${safety.meta.stars} · Forks: ${safety.meta.forks} · Age: ${safety.ageDays}d · Last push: ${safety.daysSincePush}d ago
Contributors: ${safety.contributorCount} · Language: ${safety.meta.language ?? "?"} · License: ${safety.meta.license ?? "?"}
Description: ${safety.meta.description ?? "(none)"}
${trendingLine}
Safety scan:
- risk level: ${safety.riskLevel}
- postinstall hooks: ${safety.postinstallHooks.join("; ") || "none"}
- suspicious patterns: ${safety.suspiciousPatterns.join(", ") || "none"}
- notes: ${safety.notes.join("; ") || "(none)"}

${sanitizeUntrusted(safety.readmeMd.slice(0, 15000), "REPO_README")}`;

  // Per-project override wins. Otherwise route by sensitivity (low → DeepSeek,
  // high → Anthropic). High-sensitivity is fail-closed: never silently downgraded
  // to DeepSeek when the Anthropic key is missing.
  const override = project?.llmProvider ?? "auto";
  let provider: "deepseek" | "anthropic";
  if (override === "deepseek" || override === "anthropic") {
    provider = override;
  } else {
    const isHighSensitivity = project?.sensitivity === "high";
    provider = isHighSensitivity ? "anthropic" : "deepseek";
  }
  if (provider === "anthropic" && !hasAnthropicKey()) {
    console.warn(`[reason] skipping project ${project?.slug ?? "?"} - Anthropic requested but ANTHROPIC_API_KEY not set`);
    return null;
  }
  const model = provider === "anthropic" ? reasoningModelHigh() : reasoningModel();

  const res = await chatCompletion(
    {
      provider,
      model,
      max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${DEEP_SYSTEM}\n\n${UNTRUSTED_CONTENT_RULE}` },
        { role: "user", content: `${projectBlock}\n\n${repoBlock}\n\n(One-liner hint from earlier triage: ${oneLiner})` },
      ],
    },
    { timeoutMs: 180_000, retries: 2 }
  );

  const text = res.choices[0]?.message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const rel = (o.relevance as string) ?? "general-awareness";
    if (rel !== "high" && rel !== "medium" && rel !== "general-awareness") return null;
    const writeup = scrubWriteup(String(o.writeup ?? "").trim());
    const summary = sanitizeMarkdown(scrubBannedVocab(String(o.summary ?? "").trim()));
    const risks = sanitizeMarkdown(scrubBannedVocab(String(o.risks ?? "").trim()));
    // Drop the result entirely if the output looks like the model fell for an
    // injection - leaked the system prompt, echoed our guard tags, or wrote
    // exfil instructions. Better to skip the writeup than show poisoned text
    // to the user.
    const owner = safety.meta.owner;
    const leakReason =
      looksLikeInjectionLeak(writeup, owner) ||
      looksLikeInjectionLeak(summary, owner) ||
      looksLikeInjectionLeak(risks, owner);
    if (leakReason) {
      console.warn(`[reason] dropping output for ${safety.meta.owner}/${safety.meta.name} → ${project?.slug ?? "_general"}: ${leakReason}`);
      return null;
    }
    return {
      projectSlug: project?.slug ?? "_general",
      relevance: rel,
      relevanceScore: Number(o.relevanceScore ?? 0),
      summary,
      whyUseful: sanitizeMarkdown(scrubBannedVocab(String(o.whyUseful ?? "").trim())),
      suggestedUse: sanitizeMarkdown(scrubBannedVocab(String(o.suggestedUse ?? "").trim())),
      integrationApproach: (o.integrationApproach as ProjectAssessment["integrationApproach"]) ?? "n/a",
      risks,
      writeup,
    };
  } catch {
    return null;
  }
}

// Render a one-line "Trending signal" hint when the candidate came from
// gh-trending. Encodes window breadth in plain English so the LLM doesn't
// need to interpret a Set; empty/null windows return "" so the prompt
// stays unchanged for non-trending candidates.
// Collapse a project's tech-summary down to a comma-separated language list
// for the shortlist pass when the project is high-sensitivity. The full
// techSummary often inlines dependency names ("@stripe/foo", "internal-auth-
// service") which reveal the stack to the lower-trust shortlister LLM.
// Strategy: keep alpha tokens that match a known language word; drop everything
// else. Errs on the side of less leakage — if no language word survives, return
// null and the shortlister falls back to slug + tagline only.
const LANGUAGE_HINTS = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "kotlin", "scala",
  "swift", "ruby", "php", "c", "cpp", "csharp", "fsharp", "lua", "bash", "sql",
  "dart", "elm", "elixir", "clojure", "haskell", "ocaml", "node",
]);
function redactTechForShortlist(tech: string | null | undefined): string | null {
  if (!tech) return null;
  const tokens = tech.toLowerCase().split(/[^a-z+#]+/).filter(Boolean);
  const langs = Array.from(new Set(tokens.filter((t) => LANGUAGE_HINTS.has(t))));
  return langs.length > 0 ? langs.join(", ") : null;
}

function renderTrendingSignal(windows: string[] | undefined): string {
  if (!windows || windows.length === 0) return "";
  const set = new Set(windows);
  const hasD = set.has("daily");
  const hasW = set.has("weekly");
  const hasM = set.has("monthly");
  let descriptor: string;
  if (hasD && hasW && hasM) descriptor = "appears on all three trending windows (daily + weekly + monthly) — sustained growth across timescales, not a single-day spike";
  else if (hasW && hasM) descriptor = "appears on weekly + monthly trending but not today's daily — proven attention that's cooled off recently";
  else if (hasM) descriptor = "appears on monthly trending only — slow-burn, no recent acceleration";
  else if (hasW) descriptor = "appears on weekly trending only — picked up in the last 7 days but not in today's top 25";
  else if (hasD) descriptor = "appears on today's daily trending only — single-day spike, no track record of sustained interest yet";
  else descriptor = `windows: ${windows.join(", ")}`;
  return `\nTrending signal: ${descriptor}.\n`;
}

// Strip any markdown headers the model leaked in, then run the shared
// markdown sanitiser so persisted writeups never carry inline HTML, defanged
// script schemes, control chars, or bidi/zero-width tricks regardless of
// which downstream renderer reads them.
function scrubWriteup(s: string): string {
  const stripped = s
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\s*\*\*[^*]+\*\*\s*:?\s*$/gm, "") // standalone bold "headers"
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sanitizeMarkdown(scrubBannedVocab(stripped));
}

// Orchestration

export async function reasonAboutRepo(
  safety: SafetyReport,
  projects: LocalProject[],
  discovery: DiscoveryContext | null = null,
): Promise<ReasoningOutput> {
  // Only consider projects the user has explicitly opted in.
  const included = projects.filter((p) => p.included !== false);

  // High-sensitivity projects must not be revealed to DeepSeek (the shortlister).
  // README + CLAUDE.md are dropped entirely; techSummary is collapsed to the
  // language list only (no vendor / internal-service names / package surface)
  // since the full summary often mentions dependencies that reveal the stack.
  // The deepWriteup call later routes full content to Anthropic only.
  const shortlistInput = included.map((p) =>
    p.sensitivity === "high"
      ? ({
          ...p,
          readmeMd: `[redacted - high-sensitivity project, name only]`,
          claudeMd: null,
          techSummary: redactTechForShortlist(p.techSummary),
        } as LocalProject)
      : p
  );

  const { slugs, oneLiner } = await shortlistProjects(safety, shortlistInput);
  if (slugs.length === 0) {
    return { oneLiner, safetyNotes: "", perProject: [] };
  }

  // Per-project writeups are independent LLM calls; run them in parallel and
  // tolerate per-project failure so one bad slug doesn't drop the whole repo.
  const results = await Promise.all(
    slugs.map(async (slug) => {
      const project = slug === "_general" ? null : included.find((p) => p.slug === slug) ?? null;
      if (slug !== "_general" && !project) return null;
      try {
        return await deepWriteup(safety, project, oneLiner, discovery);
      } catch (e) {
        console.warn(`[deepWriteup] failed for ${slug}:`, errorMsg(e));
        return null;
      }
    })
  );
  const out = results.filter((r): r is ProjectAssessment => r !== null);
  return { oneLiner, safetyNotes: "", perProject: out };
}

// Re-rendered card body for storage: just the prose writeup, with a tight metadata footer.
export function renderWriteup(
  repo: { owner: string; name: string; url: string },
  _reasoning: ReasoningOutput,
  project: ProjectAssessment,
  safety: SafetyReport
): string {
  const footer = [
    `License: ${safety.meta.license ?? "unknown"}`,
    `Stars: ${safety.meta.stars} (age ${safety.ageDays}d, ${safety.starVelocity.toFixed(2)} stars/day)`,
    `Last push: ${safety.daysSincePush}d ago · Contributors: ${safety.contributorCount}`,
    `Safety: ${safety.riskLevel}${safety.postinstallHooks.length ? ` · install hooks: ${safety.postinstallHooks.join(", ")}` : ""}${
      safety.suspiciousPatterns.length ? ` · patterns: ${safety.suspiciousPatterns.join(", ")}` : ""
    }`,
    project.risks ? `Risks: ${project.risks}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `${project.writeup}\n\n- - -\n${footer}`;
}
