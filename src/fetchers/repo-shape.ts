// Pipeline v2 / Sprint 1 — classify a candidate repo into one of seven
// shapes so Stage 2 (eligibility) can apply cheap structural filters
// without an LLM call:
//
//   library    : importable code surface (the thing we WANT to suggest)
//   framework  : opinionated codebase host (Next.js, Django, etc.)
//   app        : a deployable application, not for integration
//   template   : project scaffold / starter — not a library
//   tutorial   : learning material — not a library
//   aggregator : platform / SDK that bundles N integrations (Composio-class).
//                Drop-in suggesting these treats them as "use instead of
//                building" — anti-Replen value prop. Stage 2 demotes.
//   unknown    : nothing actionable identified; the LLM tier resolves.
//
// Rules are deterministic + keyword-driven. Same input → same shape.
// LLM-based shape detection is a later sprint (see pipeline-v2 doc).

export type RepoShape = "library" | "framework" | "app" | "template" | "tutorial" | "aggregator" | "unknown";

type Input = {
  name?: string | null;
  description?: string | null;
  topics?: string[] | null;
};

const TUTORIAL_HITS = /\b(tutorial|course|exercises|learn(?:ing)?|cheat[-\s]?sheet|study[-\s]?guide|handbook|primer|workshop|bootcamp)\b/i;
const TEMPLATE_HITS = /\b(template|starter|boilerplate|scaffold|seed[-\s]?project|skeleton)\b/i;
const FRAMEWORK_HITS = /\b(framework|opinionated|full[-\s]?stack)\b/i;
const APP_HITS = /\b(self[-\s]?host(?:ed)?|deploy(?:able)?|dashboard|admin\s+panel)\b/i;
// Aggregators are the dangerous-suggestion shape — multiple integrations
// bundled, "use this instead of building." The vocabulary that flags
// these:
const AGGREGATOR_HITS =
  /\b(platform|unified\s+interface|all[-\s]?in[-\s]?one|aggregator|toolkit|workbench|orchestrat(?:or|ion)|connector\s+library|sdk\s+suite|integration\s+(?:hub|platform))\b/i;
// "SDK" alone is fine (every library is technically an SDK). The danger
// signal is bundling: "1000+ tools", "every API", etc.
const BUNDLING_HITS = /\b(\d{2,}\+?\s*(?:integrations?|tools?|connectors?|toolkits?|providers?)|every\s+(?:major\s+)?(?:api|tool|integration))\b/i;
const LIBRARY_TOPIC_HITS = new Set([
  "library", "package", "module", "npm-package", "pypi-package",
  "rust-crate", "go-module", "typescript-library", "javascript-library",
  "python-library", "node-module",
]);
const APP_TOPIC_HITS = new Set([
  "self-hosted", "application", "web-app", "cli", "desktop-app",
  "electron-app", "ios-app", "android-app",
]);

export function inferRepoShape(input: Input): RepoShape {
  const name = (input.name ?? "").toLowerCase();
  const description = (input.description ?? "").toLowerCase();
  const topics = (input.topics ?? []).map((t) => t.toLowerCase());

  // "awesome-*" repos + curated-list topics are the strongest aggregator
  // signal — and they're often confidently scored high by the LLM
  // because the README reads like a textbook list of integrations.
  if (name.startsWith("awesome-") || name === "awesome") return "aggregator";
  if (topics.some((t) => t === "awesome-list" || t === "awesome" || t === "curated-list")) return "aggregator";

  // Tutorials masquerade as libraries because they sometimes have
  // package.json / pyproject.toml. Keyword check is more reliable.
  if (TUTORIAL_HITS.test(name) || TUTORIAL_HITS.test(description)) return "tutorial";
  if (topics.some((t) => /(tutorial|course|cheatsheet|study-guide|learn)/.test(t))) return "tutorial";

  // Templates / starters / boilerplates.
  if (TEMPLATE_HITS.test(name) || TEMPLATE_HITS.test(description)) return "template";
  if (topics.some((t) => /(template|starter|boilerplate|scaffold)/.test(t))) return "template";

  // Aggregator / platform / SDK-suite — Composio-class. Check both the
  // narrative pattern (description) AND the bundling pattern (counts).
  if (AGGREGATOR_HITS.test(description) || BUNDLING_HITS.test(description)) return "aggregator";
  if (topics.some((t) => /(platform|sdk-suite|orchestrator|integration-platform)/.test(t))) return "aggregator";

  // Framework — explicit topic OR phrasing like "A framework for X".
  if (FRAMEWORK_HITS.test(description)) return "framework";
  if (topics.some((t) => t === "framework" || t.endsWith("-framework"))) return "framework";

  // App / self-hosted thing-you-run. Less common but Composio's neighbours
  // (n8n, dify, etc.) live here.
  if (APP_HITS.test(description)) return "app";
  if (topics.some((t) => APP_TOPIC_HITS.has(t))) return "app";

  // Library is the default ONLY when we have some positive signal. An
  // unclassified candidate stays `unknown` so Stage 2 doesn't accidentally
  // treat noise as a library.
  if (topics.some((t) => LIBRARY_TOPIC_HITS.has(t))) return "library";
  // Heuristic: a repo with a sensible description + name pattern that
  // doesn't match anything dangerous is most likely a library. We err
  // on `library` only when the description is non-empty AND we've
  // exhausted the dangerous categories.
  if (description.length > 40 && /[a-z]/.test(name)) return "library";

  return "unknown";
}
