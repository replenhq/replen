// Stage 1: project understanding. Produces a structured summary from a
// project's README / CLAUDE.md / extra docs / techSummary. The summary is
// CONTEXT, not recommendations — gap identification (Stage 2) and matching
// (Stage 3+4) live elsewhere. See docs/stage-1-scope.md.

import { chatCompletion, triageModel } from "../analyzer/llm";
import { capabilitiesFromDeps, mergeCapabilityTags } from "./capabilities";
import { parseTechSummaryDeps } from "../fetchers/stack-watch/registry";
import { coerceModalities, inferCapabilityModality, type CapabilitySpec } from "./modality";

// Bump when the prompt or output schema changes. Bumping invalidates all
// existing summaries — they re-generate on next pipeline run.
//
// "2" (Sprint 5): prompt now consumes ProjectShape (file tree + structured
// non-markdown signal files: schemas, configs, diagrams) alongside
// readme/claude/techSummary. Old "1" summaries are grounded only in
// markdown and will mis-rank.
// "3" (Phase 2): adds capabilityTags — clean tech-capability terms that drive
// facet matching + targeted search. Old summaries lack them and re-generate.
// "4": more + more-SPECIFIC capabilityTags (8-15, sub-capabilities broken out)
// for sharper matching. Old summaries regenerate.
// "5": exclude AI-tooling/assistant config (Claude Code, MCP, agents) from
// capabilities — that's how you develop, not what the project does.
// "6" (grounded matching): adds `capabilities` — each tag now carries a GROUNDED
// descriptor (what data it operates on, the task, key constraints) + a data
// modality, so matching separates same-word/different-modality collisions
// (telemetry vs image "anomaly detection"). Old summaries regenerate.
export const PROMPT_VERSION = "6";

// Max age before we force-regenerate even if profileHash is unchanged.
// Catches the case where a user has changed direction in their head but
// hasn't pushed the doc edits yet. 3 days = sweet spot for AI-paced dev.
export const STALENESS_MS = 3 * 24 * 60 * 60 * 1000;

export type OutcomeGoal = {
  // Outcome (not a tool). E.g. "cleaner property scrapes with fewer Cloudflare flags".
  statement: string;
  // "user" = lifted verbatim from a doc the user wrote; "inferred" = LLM derived.
  source: "user" | "inferred";
  // Self-rated by the LLM. Stage-2 ignores `low` confidence inferred goals.
  // User-attributed goals are always "high".
  confidence: "high" | "medium" | "low";
};

export type CrossRepoDep = {
  direction: "consumes_from" | "feeds_into";
  // Path or owner/name reference as it appears in the docs.
  target: string;
  description: string;
};

export type LanguageHardConstraint = {
  // The capability that forces the language (e.g. "browser-runtime UI code").
  capability: string;
  // Allowed languages for that capability (e.g. ["ts", "js"]).
  allowedLanguages: string[];
};

export type ProjectSummary = {
  // Purpose: one sentence + 2-4 sentence elaboration. What this is for and who it's for.
  purpose: string;

  // 3-8 short noun phrases describing what the project DOES.
  // E.g. ["lead capture", "property browsing", "admin reporting"].
  keyCapabilities: string[];

  // Phase 2: clean, GitHub-searchable TECHNICAL capability tags — the tech a
  // project uses/needs, NOT its UI features. 1-4 words each, in the vocabulary
  // real repos use ("computer vision", "geospatial mapping", "satellite
  // imagery", "Bayesian inference", "realtime streaming"). Distinct from
  // keyCapabilities (verbose feature descriptions): these are the probes that
  // drive facet matching AND targeted GitHub search, so a CV library surfaces
  // for a project that does CV. Augmented post-LLM from the dependency set.
  capabilityTags: string[];

  // Phase "6": the grounded form of capabilityTags. One spec per tag, carrying a
  // descriptor (modality + data + task + constraints, grounded in the code) and
  // a data modality. The descriptor is what gets EMBEDDED for matching (richer
  // than the bare tag, so it doesn't collide across modalities); the modality
  // drives the cross-modal gate. capabilityTags stays the short retrieval view.
  capabilities: CapabilitySpec[];

  // Current implementation across functional areas. Keys are free-form (web,
  // scraping, data, charts, ...); values describe what's used. CONTEXT for
  // gap analysis, never a recommendation gate.
  currentTech: Record<string, string>;

  // The durable signal: what "better" means for this user.
  outcomeGoals: OutcomeGoal[];

  // From docs only (Stage 1). Auto-detection from imports is later increment.
  crossRepoDependencies: CrossRepoDep[];

  // Soft language signals. `hardConstraints` lists capabilities where the
  // runtime forces a language. Everything else is open — a Python tool can
  // serve a TS project via sidecar/pipeline.
  languageSignals: {
    hardConstraints: LanguageHardConstraint[];
    detected: string[];
  };

  // Metadata for the UI + debugging.
  generatedAt: string;
  sourceFiles: string[];
  llmModel: string;
  promptVersion: string;
};

export type SummarizeInput = {
  // Project's name and slug for context.
  name: string;
  slug: string;
  // The text inputs. README + CLAUDE.md + foldedExtraDocs come from the
  // existing loader; techSummary is the existing manifest digest.
  readmeMd: string | null;
  claudeMd: string | null;
  techSummary: string | null;
  // Agentic onboarding: the coding agent's grounded project report. When
  // present it's the strongest signal — it reflects what the agent learned from
  // reading the actual source, not just the prose docs. Null until onboarding.
  agentReport?: string | null;
  // Sprint 5: structured project shape (file tree + non-markdown signal
  // files). Null on legacy rows / projects with no shape data yet.
  shape: import("./loader").ProjectShape | null;
};

// Per-file char cap. The LLM only needs the top of each doc to grasp purpose
// and goals; the rest is implementation detail that we don't want to pay for.
const PER_FILE_CHARS = 8000;
// Total bumped for Sprint 5: shape (fileTree + structured) adds genuine
// signal the markdown alone misses, so we widen the budget to fit it.
const TOTAL_INPUT_CHARS = 48000;
// File tree is sent as a compact path list. Cap on count so a huge repo
// doesn't dominate. Each path is ~40 chars avg → 250 paths ≈ 10KB.
const FILE_TREE_CAP = 250;
// Structured (configs/schemas/diagrams) cap inside the prompt. The loader
// already caps the stored blob at 60KB; this is the prompt slice.
const STRUCTURED_PROMPT_CHARS = 24_000;

const SYSTEM_PROMPT = `You extract a structured summary of a software project so that another
system (replen) can later find tools and libraries that would improve the
project's outcomes.

Your job is CONTEXT, not RECOMMENDATIONS:
- Describe what the project is for, what it does, what outcomes the author
  cares about, and any genuine technical constraints.
- Do NOT suggest tools, libraries, or improvements. That's a separate step.
- Do NOT identify gaps. That's a separate step.

Rules:
- If the user has stated an outcome verbatim in their docs (e.g. "I want
  faster scrapes"), lift it word-for-word. Mark it source="user", confidence="high".
- If you infer an outcome that wasn't stated, mark source="inferred" and
  self-rate confidence based on how clearly the docs support it.
- Language is a SOFT signal. Only list a hardConstraint when the runtime
  GENUINELY forces a language (e.g. "browser-runtime UI code must compile
  to JavaScript"). Backend services, data pipelines, scrapers, ML inference
  — none of these are hard language constraints.
- currentTech is descriptive context, never used as a filter for what to
  recommend. A TypeScript project can absolutely use a Python tool via a
  sidecar process.
- If the docs are sparse, the summary should be sparse. Don't pad. Don't
  invent capabilities or outcomes that aren't grounded in the input.
- The "Repo file tree" + "Structured signal files" sections (when present)
  are GROUND TRUTH about the project's actual shape. Trust them over the
  prose docs when they conflict — a docs description of "we use Postgres"
  with no schema file is weaker evidence than a tree showing
  prisma/schema.prisma with explicit models. Mention specific filenames /
  directories in currentTech where they tell the matching system something
  precise (e.g. currentTech.images: "branded social cards rendered in
  lib/social/imageRenderer.ts").
- capabilityTags are the most important field for matching. They are SHORT,
  GitHub-searchable TECHNICAL capability terms — the tech the project uses or
  needs, NOT its UI features and NOT its domain. 1-4 words each, in the
  vocabulary real OSS repos use in their description/topics. Derive them from
  the deps, imports, file tree, and configs — not just prose.
  Aim for 8-15 tags, and be SPECIFIC — specific tags match far better than
  broad ones. Break a broad capability into the concrete techniques the project
  actually uses. "web scraping" is OK, but if the code does more, emit the
  precise sub-capabilities too: "headless browser", "cloudflare bypass",
  "anti-bot evasion", "proxy rotation", "session handling". Prefer the precise
  term a library would describe itself with. Examples:
    - a scraper that beats Cloudflare with a headless browser and rotates auth →
      ["web scraping","headless browser","cloudflare bypass","anti-bot evasion",
       "proxy rotation","session handling","captcha solving","rate limiting"]
    - a defense map UI that shows drone imagery and scores threats →
      ["computer vision","object detection","image segmentation",
       "satellite imagery","geospatial mapping","sensor fusion",
       "Bayesian inference","realtime streaming"]
  Each tag must be something you could paste into GitHub search and get
  relevant libraries back. FORBIDDEN: the project's own name, domain words
  ("defense","fintech"), UI features ("dashboard","map view"), vague terms
  ("data","api","backend"), and — IMPORTANT — AI-tooling / assistant config
  (Claude Code, Cursor, Copilot, MCP, agents, hooks, "Claude Code
  Configuration"). Those describe HOW the project is developed, not what it
  DOES — ignore them even when CLAUDE.md / AGENTS.md / GEMINI.md mention them.
  Be specific and thorough about the project's REAL technical work, not generic.
- "capabilities" is the GROUNDED form of capabilityTags — emit one object per
  tag. Each has:
    - "tag": the same short GitHub-searchable term.
    - "descriptor": one grounded sentence that disambiguates it — WHAT DATA it
      operates on, the SPECIFIC task, and any key constraint. This is critical:
      "anomaly detection" is ambiguous (images? telemetry?), but "rule-based
      anomaly detection over drone telemetry time-series — link-loss, GPS-drop,
      battery-sag; no ML" is not. Ground it in the file tree / configs / deps,
      not marketing. Avoid the project's domain words; describe the tech.
    - "modality": the data modality this capability operates on, as an array from
      EXACTLY this set: ["image","video","timeseries","tabular","text","audio",
      "geospatial","graph","3d","code","network"]. Use [] only if genuinely
      none apply. A satellite-imagery segmenter is ["image","geospatial"]; a
      telemetry detector is ["timeseries"]; a recsys is ["tabular"].

Output JSON only. No prose before or after. Schema:
{
  "purpose": "string (1 sentence + 2-4 sentence elaboration)",
  "keyCapabilities": ["3-8 short noun phrases"],
  "capabilityTags": ["3-10 short GitHub-searchable tech capability terms"],
  "capabilities": [
    { "tag": "...", "descriptor": "grounded one-liner", "modality": ["image", ...] }
  ],
  "currentTech": { "web": "...", "scraping": "...", ... },
  "outcomeGoals": [
    { "statement": "...", "source": "user" | "inferred", "confidence": "high" | "medium" | "low" }
  ],
  "crossRepoDependencies": [
    { "direction": "consumes_from" | "feeds_into", "target": "...", "description": "..." }
  ],
  "languageSignals": {
    "hardConstraints": [{ "capability": "...", "allowedLanguages": ["..."] }],
    "detected": ["..."]
  }
}`;

function buildUserPrompt(input: SummarizeInput): string {
  const parts: string[] = [`Project: ${input.name} (slug: ${input.slug})`];
  const claudeMd = (input.claudeMd ?? "").slice(0, PER_FILE_CHARS);
  const readmeMd = (input.readmeMd ?? "").slice(0, PER_FILE_CHARS);
  const techSummary = (input.techSummary ?? "").slice(0, 2000);
  // The agent report (when present) is the strongest grounding — surface it
  // first and tell the model to weight it. It's the code-read understanding.
  const agentReport = (input.agentReport ?? "").slice(0, PER_FILE_CHARS);
  if (agentReport) parts.push(`\n--- Agent project report (GROUND TRUTH — the user's coding agent's code-read understanding; weight this highest) ---\n${agentReport}`);
  if (claudeMd) parts.push(`\n--- CLAUDE.md ---\n${claudeMd}`);
  if (readmeMd) parts.push(`\n--- README.md ---\n${readmeMd}`);
  if (techSummary) parts.push(`\n--- techSummary (manifest digest) ---\n${techSummary}`);
  // Sprint 5: project shape — file tree + structured non-markdown signals.
  // Trim the file tree to FILE_TREE_CAP entries by stride sampling so we
  // keep diversity across the repo rather than just the alphabetic head.
  if (input.shape) {
    const { fileTree, structured } = input.shape;
    if (fileTree.length > 0) {
      const stride = Math.max(1, Math.ceil(fileTree.length / FILE_TREE_CAP));
      const sampled = stride === 1 ? fileTree : fileTree.filter((_, i) => i % stride === 0);
      parts.push(`\n--- Repo file tree (${fileTree.length} files; showing ${sampled.length}) ---\n${sampled.join("\n")}`);
    }
    if (structured.length > 0) {
      const trimmed = structured.slice(0, STRUCTURED_PROMPT_CHARS);
      parts.push(`\n--- Structured signal files (schemas, configs, diagrams) ---\n${trimmed}`);
    }
  }
  const joined = parts.join("\n");
  // Hard cap on total input size so we don't blow the LLM context window.
  return joined.length > TOTAL_INPUT_CHARS ? joined.slice(0, TOTAL_INPUT_CHARS) : joined;
}

// Coerce arbitrary LLM-returned JSON into a ProjectSummary. Defensive: we
// don't trust the LLM to follow the schema exactly. Missing fields → empty
// arrays / objects; unknown enum values → coerced to safe defaults.
function coerceSummary(raw: unknown, model: string, sourceFiles: string[]): ProjectSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  const langSig = (o.languageSignals ?? {}) as Record<string, unknown>;
  return {
    purpose: typeof o.purpose === "string" ? o.purpose : "",
    keyCapabilities: Array.isArray(o.keyCapabilities) ? o.keyCapabilities.filter((s): s is string => typeof s === "string") : [],
    capabilityTags: Array.isArray(o.capabilityTags) ? o.capabilityTags.filter((s): s is string => typeof s === "string") : [],
    capabilities: Array.isArray(o.capabilities)
      ? o.capabilities
          .map((c) => {
            const cc = (c ?? {}) as Record<string, unknown>;
            const tag = typeof cc.tag === "string" ? cc.tag.trim() : null;
            if (!tag) return null;
            const descriptor = typeof cc.descriptor === "string" ? cc.descriptor.trim() : "";
            // Fall back to inferring the modality from tag+descriptor when the LLM omitted it.
            const modality = coerceModalities(cc.modality);
            // Server-side summarizer = inferred from docs (the agent path, which is
            // grounded, comes through the capabilities route instead).
            return { tag, descriptor, modality: modality.length ? modality : inferCapabilityModality(tag, descriptor), provenance: "inferred" } as CapabilitySpec;
          })
          .filter((c): c is CapabilitySpec => c !== null)
      : [],
    currentTech: (o.currentTech && typeof o.currentTech === "object" && !Array.isArray(o.currentTech))
      ? Object.fromEntries(
          Object.entries(o.currentTech as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>
      : {},
    outcomeGoals: Array.isArray(o.outcomeGoals)
      ? o.outcomeGoals
          .map((g) => {
            const gg = (g ?? {}) as Record<string, unknown>;
            const statement = typeof gg.statement === "string" ? gg.statement : null;
            if (!statement) return null;
            const source = gg.source === "user" ? "user" : "inferred";
            const confRaw = gg.confidence;
            const confidence: "high" | "medium" | "low" =
              source === "user" ? "high" :
              confRaw === "high" || confRaw === "medium" || confRaw === "low" ? confRaw : "medium";
            return { statement, source, confidence } as OutcomeGoal;
          })
          .filter((g): g is OutcomeGoal => g !== null)
      : [],
    crossRepoDependencies: Array.isArray(o.crossRepoDependencies)
      ? o.crossRepoDependencies
          .map((d) => {
            const dd = (d ?? {}) as Record<string, unknown>;
            const direction = dd.direction === "feeds_into" ? "feeds_into" : "consumes_from";
            const target = typeof dd.target === "string" ? dd.target : null;
            const description = typeof dd.description === "string" ? dd.description : "";
            if (!target) return null;
            return { direction, target, description } as CrossRepoDep;
          })
          .filter((d): d is CrossRepoDep => d !== null)
      : [],
    languageSignals: {
      hardConstraints: Array.isArray(langSig.hardConstraints)
        ? langSig.hardConstraints
            .map((c) => {
              const cc = (c ?? {}) as Record<string, unknown>;
              const capability = typeof cc.capability === "string" ? cc.capability : null;
              const allowed = Array.isArray(cc.allowedLanguages)
                ? cc.allowedLanguages.filter((s): s is string => typeof s === "string")
                : [];
              if (!capability || allowed.length === 0) return null;
              return { capability, allowedLanguages: allowed } as LanguageHardConstraint;
            })
            .filter((c): c is LanguageHardConstraint => c !== null)
        : [],
      detected: Array.isArray(langSig.detected)
        ? langSig.detected.filter((s): s is string => typeof s === "string")
        : [],
    },
    generatedAt: new Date().toISOString(),
    sourceFiles,
    llmModel: model,
    promptVersion: PROMPT_VERSION,
  };
}

export async function generateProjectSummary(input: SummarizeInput): Promise<ProjectSummary | null> {
  // Bail early if we have absolutely nothing to summarize. A project with no
  // docs and no manifest is invisible to the LLM — better to skip than to
  // hallucinate a summary from just the slug.
  if (!input.claudeMd && !input.readmeMd && !input.techSummary && !input.agentReport) {
    return null;
  }
  const sourceFiles = [
    input.agentReport ? "agentReport" : null,
    input.claudeMd ? "CLAUDE.md" : null,
    input.readmeMd ? "README.md" : null,
    input.techSummary ? "techSummary" : null,
  ].filter((s): s is string => s !== null);

  const model = triageModel();
  const res = await chatCompletion(
    {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 2000,
    },
    { timeoutMs: 60_000, retries: 1 },
  );
  const text = res.choices?.[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn(`[summarize] ${input.slug} returned non-JSON: ${(e as Error).message}; sample: ${text.slice(0, 200)}`);
    return null;
  }
  const summary = coerceSummary(parsed, model, sourceFiles);
  // Augment the LLM's capabilityTags with deterministic dep→capability tags —
  // catches tech the docs never name (a project that imports cv2 does computer
  // vision whether or not its README says so). Merged + deduped + capped.
  const depCaps = capabilitiesFromDeps(parseTechSummaryDeps(input.techSummary));
  summary.capabilityTags = mergeCapabilityTags(summary.capabilityTags, depCaps);
  // Reconcile grounded specs against the final (merged) tag list: every tag —
  // including dep-derived ones the LLM never saw — gets a spec, reusing the
  // LLM's grounded descriptor where it exists and inferring modality otherwise.
  summary.capabilities = reconcileCapabilities(summary.capabilityTags, summary.capabilities);
  return summary;
}

/**
 * Ensure one CapabilitySpec per final capabilityTag. Grounded LLM specs win
 * (matched case-insensitively by tag); tags with no spec (dep-derived) get a
 * minimal spec with an inferred modality and no descriptor (the bare-label
 * embedding is used). Order follows capabilityTags.
 */
export function reconcileCapabilities(tags: string[], specs: CapabilitySpec[]): CapabilitySpec[] {
  const byTag = new Map<string, CapabilitySpec>();
  for (const s of specs) {
    const k = s.tag.trim().toLowerCase();
    if (k && !byTag.has(k)) byTag.set(k, s);
  }
  const out: CapabilitySpec[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const k = tag.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const s = byTag.get(k);
    if (s) {
      out.push({ tag, descriptor: s.descriptor, modality: s.modality.length ? s.modality : inferCapabilityModality(tag, s.descriptor), provenance: s.provenance ?? (s.descriptor ? "grounded" : "inferred") });
    } else {
      // No spec for this tag = it came from the deterministic dep→capability table.
      out.push({ tag, descriptor: "", modality: inferCapabilityModality(tag), provenance: "extracted" });
    }
  }
  return out;
}

// Cache-invalidation predicate. True if we need to (re)generate the summary.
export function needsRegeneration(args: {
  summaryJson: string | null;
  summaryHash: string | null;
  summaryGeneratedAt: Date | null;
  summaryPromptVersion: string | null;
  currentProfileHash: string;
}): { regen: boolean; reason: string } {
  if (!args.summaryJson) return { regen: true, reason: "no-summary" };
  if (args.summaryHash !== args.currentProfileHash) return { regen: true, reason: "profile-hash-changed" };
  if (args.summaryPromptVersion !== PROMPT_VERSION) return { regen: true, reason: "prompt-version-bumped" };
  if (!args.summaryGeneratedAt) return { regen: true, reason: "no-timestamp" };
  const ageMs = Date.now() - args.summaryGeneratedAt.getTime();
  if (ageMs > STALENESS_MS) return { regen: true, reason: `older-than-${Math.floor(STALENESS_MS / 86400000)}d` };
  return { regen: false, reason: "fresh" };
}
