import { chatCompletion, triageModel } from "./llm";
import type { SafetyReport } from "../scanner/safety";
import { sanitizeUntrusted, UNTRUSTED_CONTENT_RULE } from "./guards";

export type TriageVerdict = {
  shouldReason: boolean;
  oneLiner: string;
  category: string;
};

const SYSTEM = `You are a fast triage filter for a personal open-source digest.
The reader is an indie developer hunting for *under-the-radar* tools and
libraries they could pull into their own projects. They are NOT looking for:
  - Product launches or marketing from big AI/cloud companies (Anthropic,
    OpenAI, Google, Microsoft, Vercel, Cloudflare, Supabase, Neon, etc.)
  - **Established mega-projects of any kind.** Concretely: any repo that
    is BOTH (a) over ~10,000 stars AND (b) has been at that level for over
    a year. The reader has been writing software for years and has heard
    of these. Examples to reject: react, vue, next.js, django, fastapi,
    flask, postgres, kubernetes, ffmpeg, ollama, langchain, vercel/ai,
    tanstack/query, drizzle, prisma, shadcn-ui, tailwindcss, axios,
    lodash, eslint, prettier, vite, webpack, pytorch, tensorflow, numpy,
    pandas, scikit-learn, requests, sqlalchemy, pydantic, beautifulsoup,
    serde, tokio, axum, gin, gorm, htmx, alpine, etc. If a repo has 25k+
    stars and a 1+ year history, the chance the reader already knows
    about it approaches certainty — Replen's value is **under-the-radar
    specifics**, not "have you considered React?" Be generous in rejecting
    anything that smells like "the obvious choice in this language."
    Recent viral repos (0 → 50k in months, e.g. bun, cursor, ollama in
    2024) are EXCEPTIONS — they may still be worth surfacing if the
    description suggests a specific drop-in use the reader's codebase
    can't easily duplicate. Default to keep when viral-and-recent and
    use the score band to express uncertainty.
  - Documentation sites, tutorials, course material, awesome-* lists, scraped
    mirrors, joke repos, empty stubs
  - "AI SDK for company X" repos that are essentially client libraries for a
    big company's paid API
  - Whitepapers / model weights / research dumps with no integration story
  - **Skill packs / skill collections** for AI coding tools (claude-skills,
    cursor-rules-collection, agent-skills-*, codex-prompts, etc.). Not an
    integrate-able component — just a bundle of prompts/instructions.
  - **Full-stack agentic frameworks** where adoption means rewriting the
    project against the framework's abstractions, rather than borrowing a
    focused library. Mark these as category "framework" and reject — if
    they're genuinely good the reader will hear about them through normal
    channels (AWS-effect). Replen's value is *under-the-radar specifics*,
    not the day's viral framework launch. Specific-purpose libraries that
    solve one problem (a parser, a queue, a vector store, a renderer) are
    fine, even if they call themselves a "framework" in passing.

DO keep small/new/personal projects (any star count) that look like a
single-purpose tool, library, or service the developer could actually plug
in to an existing project without committing to a whole stack.

Decide:
1. Is this a real, distinct, integrate-able OSS project (not the kinds listed above)?
2. Could it plausibly be useful to a working software engineer who builds AI, web, and infra projects?
3. In one sentence, what is the project?

Output JSON only, no prose:
{"keep": boolean, "category": "string", "oneLiner": "string"}

Categories: ai-model, ai-agent, ai-tooling, dev-tooling, infra, web-framework, library, cli, data, security, observability, skill-pack, framework, other.

If category is "skill-pack" or "framework", keep MUST be false.`;

export async function triage(safety: SafetyReport): Promise<TriageVerdict> {
  // Deterministic fast-path: skip the LLM call for repos whose name or
  // description matches a known no-go pattern (skill packs, awesome-*,
  // etc.). Saves a triage-model call + keeps the rejection reason
  // predictable across runs. Patterns are conservative — they only fire
  // when the repo's name/description openly self-describes as a
  // skill-pack-or-similar.
  const quick = quickRejectByName(safety.meta);
  if (quick) {
    return { shouldReason: false, oneLiner: quick.reason, category: quick.category };
  }

  const userText = `Repo: ${safety.meta.owner}/${safety.meta.name}
Stars: ${safety.meta.stars} | Age: ${safety.ageDays}d | Last push: ${safety.daysSincePush}d ago | Contributors: ${safety.contributorCount}
Language: ${safety.meta.language ?? "?"} | License: ${safety.meta.license ?? "?"}
Description: ${safety.meta.description ?? "(none)"}

${sanitizeUntrusted(safety.readmeMd.slice(0, 8000), "REPO_README")}`;

  const res = await chatCompletion({
    model: triageModel(),
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${SYSTEM}\n\n${UNTRUSTED_CONTENT_RULE}` },
      { role: "user", content: userText },
    ],
  });

  const text = res.choices[0]?.message?.content ?? "";
  return parseTriage(text);
}

function quickRejectByName(meta: { owner: string; name: string; description: string | null }): { reason: string; category: string } | null {
  const name = meta.name.toLowerCase();
  const desc = (meta.description ?? "").toLowerCase();
  const fullName = `${meta.owner}/${meta.name}`.toLowerCase();

  // Awesome-* lists. The triage LLM already rejects these but a
  // string-match here saves a per-list LLM call.
  if (name.startsWith("awesome-") || name === "awesome") {
    return { reason: "Awesome-list (no integrate-able component)", category: "other" };
  }

  // Skill packs for AI coding tools. Names that openly describe themselves
  // as bundles of prompts/instructions for claude / cursor / codex / etc.
  // We treat these as a category Replen never wants to surface — they're
  // not components, just configuration bundles.
  if (/(^|[-_])skills?(-pack|-collection|-bundle|-kit)?$/.test(name)) {
    return { reason: "Skill pack — not an integrate-able component", category: "skill-pack" };
  }
  if (/(^|[-_])(agent|claude|cursor|codex|copilot|windsurf|aider|cline)[-_]skills?/.test(name)) {
    return { reason: "AI-tool skill pack — not an integrate-able component", category: "skill-pack" };
  }
  if (/(^|[-_])(rules|prompts)[-_](pack|collection|bundle|library|repo)/.test(name)) {
    return { reason: "Prompt/rules pack — not an integrate-able component", category: "skill-pack" };
  }
  // Description-based check for cases where the name is generic but the
  // description plainly states "skills for X". Be strict: require the
  // explicit phrase to avoid false positives on libraries that mention
  // skills in passing.
  if (/(skills?|prompts?|rules?) for (claude|cursor|codex|copilot|windsurf|aider)/.test(desc)) {
    return { reason: "Skill / prompt collection — not an integrate-able component", category: "skill-pack" };
  }
  if (/collection of (skills?|prompts?|rules?|instructions?)/.test(desc)) {
    return { reason: "Skill / prompt collection — not an integrate-able component", category: "skill-pack" };
  }

  // "free-X" / "X-alternative" wrappers around paid products. Often
  // viral, rarely an integrate-able library.
  if (/^free-(claude|gpt|chatgpt|cursor|copilot)/.test(name)) {
    return { reason: "Free-wrapper around paid product — not an integrate-able component", category: "other" };
  }

  // Description-detected agent platforms / frameworks. These are
  // explicitly the AWS-effect targets the user flagged: viral,
  // popular, and either a "build on top of us" framework (the user
  // has to rewrite against the framework's abstractions) or a
  // "unified interface for everything" SDK (composio-style). If the
  // repo openly describes itself this way, skip without an LLM call.
  // Keep the patterns precise so single-purpose libraries that
  // mention "agents" or "framework" in passing don't trip.
  const FRAMEWORK_DESC_PATTERNS = [
    /unified (?:interface|api|sdk) (?:to|for) (?:\d+\+?\s+)?(?:tool|service|integration|agent)/,
    /platform for (?:ai |building )?agents?/,
    /cowork platform/,
    /agent (?:hub|platform|orchestrator|coordination)/,
    /sdk for (?:building |connecting )?(?:ai )?agents?/,
    /framework for building (?:ai |autonomous )?agents?/,
    /\d{2,}\+?\s+(?:tool|integration|toolkit)s?/,  // "1000+ toolkits"
    /one-stop (?:shop|platform) for/,
    /all-in-one (?:platform|framework|sdk)/,
  ];
  for (const re of FRAMEWORK_DESC_PATTERNS) {
    if (re.test(desc)) {
      return { reason: `Framework / platform repo — surfacing this is the AWS effect, not under-the-radar`, category: "framework" };
    }
  }

  // Marker for grep: ensures fullName is at least referenced; could be
  // used in future patterns. Currently no patterns key off fullName
  // directly so this stays unused.
  void fullName;

  return null;
}

// Categories Replen never surfaces, regardless of what the LLM
// returns for `keep`. Defence-in-depth against the model contradicting
// itself ("keep: true, category: skill-pack").
const NEVER_KEEP_CATEGORIES = new Set(["skill-pack", "framework"]);

function parseTriage(text: string): TriageVerdict {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { shouldReason: false, oneLiner: "(triage parse failed)", category: "other" };
  try {
    const o = JSON.parse(jsonMatch[0]);
    const category = String(o.category ?? "other");
    const shouldReason = NEVER_KEEP_CATEGORIES.has(category) ? false : !!o.keep;
    return {
      shouldReason,
      oneLiner: String(o.oneLiner ?? "").slice(0, 280),
      category,
    };
  } catch {
    return { shouldReason: false, oneLiner: "(triage parse failed)", category: "other" };
  }
}
