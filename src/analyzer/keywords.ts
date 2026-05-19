import { chatCompletion, triageModel } from "./llm";

// Derive 3-5 GitHub-topic-style search keywords from a project's docs.
// Stored once per project_profile (in search_keywords) and re-derived only
// when the profileHash changes. Used by the gh-search fetcher to surface
// repos in the project's niche that trending feeds never see.
//
// Output shape: comma-separated lowercase hyphenated tokens, like
//   "computer-vision,object-detection,supervision-library,bounding-box"
// Designed to plug directly into GitHub's search syntax (topic:foo /
// keyword fallback) without further normalisation.

export type KeywordDerivationInput = {
  slug: string;
  name: string;
  readmeMd: string | null;
  claudeMd: string | null;
  techSummary: string | null;
};

const SYSTEM_PROMPT = `You read project docs and extract the 3-5 GitHub-searchable keywords that best describe the project's domain and stack. Output ONLY the keywords as a comma-separated list, lowercase, hyphenated. No prose, no quotes, no numbering. Prefer specific technical terms over generic ones (e.g. "object-detection" over "machine-learning", "next-app-router" over "web-framework").`;

function buildUserPrompt(p: KeywordDerivationInput): string {
  const parts: string[] = [`Project: ${p.name} (${p.slug})`];
  if (p.techSummary) parts.push(`Tech: ${p.techSummary}`);
  if (p.claudeMd) parts.push(`CLAUDE.md (first 2000 chars):\n${p.claudeMd.slice(0, 2000)}`);
  if (p.readmeMd) parts.push(`README (first 3000 chars):\n${p.readmeMd.slice(0, 3000)}`);
  parts.push("\nReturn 3-5 keywords, comma-separated.");
  return parts.join("\n\n");
}

export async function deriveSearchKeywords(p: KeywordDerivationInput): Promise<string | null> {
  // Skip entirely if there's nothing meaningful to read.
  if (!p.readmeMd && !p.claudeMd && !p.techSummary) {
    console.log(`[keywords] ${p.slug}: no docs to read, skipping`);
    return null;
  }
  // Try LLM derivation first. Fall back to heuristic extraction if the LLM
  // returns garbage / empty / unparseable, rather than silently producing
  // null and disabling gh-search for the project (which was the prior
  // behaviour and disabled the whole fetcher for every project in prod).
  const userPrompt = buildUserPrompt(p);
  let raw = "";
  try {
    const res = await chatCompletion({
      model: triageModel(),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 80,
      temperature: 0.2,
    });
    raw = res.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    console.warn(`[keywords] ${p.slug}: LLM derivation failed: ${(e as Error).message}`);
  }

  const llmResult = normalize(raw);
  if (llmResult) return llmResult;

  // LLM produced nothing parseable. Log what it actually returned so the
  // failure mode is visible in logs, then fall back to heuristic extraction.
  if (raw.trim().length > 0) {
    console.warn(`[keywords] ${p.slug}: LLM returned unparseable content (len=${raw.length}): ${raw.slice(0, 120).replace(/\n/g, " ")}`);
  }
  const fallback = heuristicKeywords(p);
  if (fallback) {
    console.log(`[keywords] ${p.slug}: using heuristic fallback: ${fallback}`);
    return fallback;
  }
  return null;
}

// Last-resort keyword extraction from project metadata. Used when the LLM
// path fails (timeout, empty response, prose instead of CSV). Lower quality
// than the LLM path but keeps gh-search alive for the project rather than
// disabling it silently.
//
// Strategy: extract deps from techSummary's "deps: react, next-auth, ..."
// line, plus meaningful tokens from the project slug (drop generic ones
// like "app", "site", "api"). Returns up to 5 hyphenated tokens.
function heuristicKeywords(p: KeywordDerivationInput): string | null {
  const tokens = new Set<string>();
  // techSummary line is "node project: foo; deps: react, next-auth, ..."
  // Pull deps out and keep the first 4: highest-signal stack hints.
  if (p.techSummary) {
    const depMatch = p.techSummary.match(/deps?:\s*([^\n]+)/i);
    if (depMatch) {
      for (const t of depMatch[1].split(",").slice(0, 4)) {
        const cleaned = t.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (cleaned.length >= 3 && cleaned.length <= 30) tokens.add(cleaned);
      }
    }
  }
  // Project slug tokens (e.g. "acme-phase2" -> "acme", "phase2"),
  // filtered to drop generic suffixes that wouldn't help a GitHub search.
  const SLUG_NOISE = new Set(["app", "site", "api", "web", "ui", "frontend", "backend", "v1", "v2", "v3", "stage", "test", "demo", "old", "new"]);
  for (const t of p.slug.toLowerCase().split(/[-_]/)) {
    if (t.length >= 3 && !SLUG_NOISE.has(t) && !/^\d+$/.test(t)) tokens.add(t);
  }
  if (tokens.size === 0) return null;
  return [...tokens].slice(0, 5).join(",");
}

function normalize(raw: string): string | null {
  // The LLM occasionally wraps the list in quotes, prefixes with "Keywords:",
  // adds trailing punctuation, or returns each token on a new line. Strip
  // and validate. Splits on commas AND newlines so multi-line responses
  // ("foo\nbar\nbaz") parse correctly. Strips leading list-markers
  // ("1. ", "- ", "* ") so numbered/bulleted output normalises too.
  const cleaned = raw
    .replace(/^\s*keywords?\s*:\s*/i, "")
    .replace(/^["'\s]+|["'\s.]+$/g, "")
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase().replace(/^[*\-\d.)\s]+/, "").replace(/[^a-z0-9-]/g, ""))
    .filter((t) => t.length >= 2 && t.length <= 40);
  if (cleaned.length === 0) return null;
  return [...new Set(cleaned)].slice(0, 5).join(",");
}
