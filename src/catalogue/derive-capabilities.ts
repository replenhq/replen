// Grow the capability vocabulary from the ecosystem's OWN vocabulary, instead
// of a hand-curated list. Every catalogue repo self-labels with GitHub topics
// ("web-scraping", "headless-browser", "object-detection"). Mining the frequent
// ones gives us hundreds of real, in-use capabilities — and it's a flywheel:
// capabilities → search → repos → their topics → new capabilities → more repos.
//
// Combined with the k-anonymised capabilities from real user projects, the
// vocabulary scales to thousands organically, from what the ecosystem actually
// uses — no hand-typing 500 terms.

import { db, schema } from "../db/client";
import { isNotNull } from "drizzle-orm";

// Topics that are languages, frameworks, or meta — not capabilities. Dropped.
const STOP_TOPICS = new Set([
  "javascript", "typescript", "python", "java", "golang", "go", "rust", "ruby",
  "php", "cpp", "c", "csharp", "swift", "kotlin", "scala", "dart", "elixir",
  "nodejs", "node", "deno", "bun", "react", "reactjs", "vue", "vuejs", "angular",
  "svelte", "nextjs", "nuxt", "django", "flask", "fastapi", "rails", "spring",
  "dotnet", "laravel", "express", "library", "libraries", "framework", "sdk",
  "api", "apis", "cli", "tool", "tools", "toolkit", "app", "application",
  "open-source", "opensource", "hacktoberfest", "awesome", "awesome-list",
  "boilerplate", "starter", "template", "example", "examples", "demo", "sample",
  "tutorial", "course", "learning", "book", "documentation", "docs", "guide",
  "windows", "linux", "macos", "android", "ios", "web", "frontend", "backend",
  "fullstack", "self-hosted", "selfhosted", "docker", "kubernetes", "cloud",
  "database", "data", "software", "programming", "developer-tools", "devtools",
  // Framework / library NAMES are deps, not capabilities.
  "pytorch", "tensorflow", "keras", "jax", "scikit-learn", "sklearn", "numpy",
  "pandas", "opencv", "openai", "anthropic", "langchain", "llamaindex", "ollama",
  "huggingface", "transformers", "pydantic", "sqlalchemy", "redis", "postgresql",
  "postgres", "mongodb", "mysql", "sqlite", "kafka", "rabbitmq", "elasticsearch",
  "graphql", "grpc", "webpack", "vite", "babel", "eslint", "prettier", "jest",
  "pytest", "tailwindcss", "tailwind", "bootstrap", "electron", "flutter",
  // AI hype / buzzwords — too broad or not a technical capability.
  "ai", "llm", "llms", "rag", "genai", "generative-ai", "artificial-intelligence",
  "machine-intelligence", "chatgpt", "gpt", "gpt-4", "gpt4", "chatbot", "chatbots",
  "ai-agents", "agents", "agent", "agentic", "mcp", "prompt", "prompts", "chatglm",
  "claude", "claude-code", "claudecode", "copilot", "github-copilot", "cursor",
  "codex", "gemini", "model-context-protocol", "claude-code-configuration",
  "automation", "productivity", "monitoring", "analytics", "dashboard", "ui", "ux",
  "security", "privacy", "performance", "testing", "deployment", "scalability",
]);

// Repos that are AI-hype / meta / curated content rather than capability
// libraries — they go viral (huge stars fast) but aren't something you adopt.
// Used to gate trending ingestion + the "rising" flag.
export function looksLikeHype(name: string, description: string | null): boolean {
  const n = name.toLowerCase();
  const d = (description ?? "").toLowerCase();
  if (/(^|[-_])skills?([-_]|$)|awesome|cheat-?sheet|roadmap|interview|handbook|курс|prompts?$/.test(n)) return true;
  if (/\b(curated list|collection of|list of|prompts? for|cheat ?sheet|study guide|learn \w+ in)\b/.test(d)) return true;
  return false;
}

/** Normalise a GitHub topic into a capability phrase ("web-scraping" → "web scraping"). */
function normTopic(t: string): string {
  return t.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/** True if a capability label is a stop-topic (framework name / buzzword / meta). */
export function isStopTopic(label: string): boolean {
  const lower = label.toLowerCase();
  const n = normTopic(label);
  return STOP_TOPICS.has(lower) || STOP_TOPICS.has(n) || STOP_TOPICS.has(n.replace(/ /g, "-"));
}

/**
 * Mine the catalogue's repo topics for frequent capability terms not already in
 * the vocabulary. Returns the candidates (most-common first), capped.
 */
export async function deriveCapabilitiesFromTopics(opts?: {
  minRepos?: number;   // topic must appear in at least this many catalogue repos
  max?: number;        // cap on how many new capabilities to return
}): Promise<{ candidates: string[]; scanned: number }> {
  const minRepos = Math.max(2, opts?.minRepos ?? 5);
  const max = Math.max(1, opts?.max ?? 150);

  const rows = await db.select({ topics: schema.catalogueRepos.topics }).from(schema.catalogueRepos).where(isNotNull(schema.catalogueRepos.topics));
  const freq = new Map<string, number>();
  for (const r of rows) {
    let ts: string[] = [];
    try { ts = r.topics ? JSON.parse(r.topics) : []; } catch { continue; }
    const seen = new Set<string>(); // count each topic once per repo
    for (const raw of ts) {
      if (typeof raw !== "string") continue;
      const t = normTopic(raw);
      if (t.length < 3 || t.length > 40) continue;
      if (t.split(" ").length > 4) continue;
      if (STOP_TOPICS.has(raw.toLowerCase()) || STOP_TOPICS.has(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }

  const existing = new Set(
    (await db.select({ label: schema.catalogueCapabilities.label }).from(schema.catalogueCapabilities))
      .map((r) => r.label.toLowerCase()),
  );

  const candidates = [...freq.entries()]
    .filter(([t, c]) => c >= minRepos && !existing.has(t))
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, max);

  return { candidates, scanned: rows.length };
}
