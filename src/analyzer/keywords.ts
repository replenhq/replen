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
  const userPrompt = buildUserPrompt(p);
  // Skip the LLM call entirely if there's nothing meaningful to read.
  if (!p.readmeMd && !p.claudeMd && !p.techSummary) return null;
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
    const raw = res.choices?.[0]?.message?.content ?? "";
    return normalize(raw);
  } catch (e) {
    console.warn(`[keywords] LLM derivation failed for ${p.slug}:`, e);
    return null;
  }
}

function normalize(raw: string): string | null {
  // The LLM occasionally wraps the list in quotes, prefixes with "Keywords:",
  // or adds trailing punctuation. Strip aggressively and validate.
  const cleaned = raw
    .replace(/^\s*keywords?\s*:\s*/i, "")
    .replace(/^["'\s]+|["'\s.]+$/g, "")
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, ""))
    .filter((t) => t.length >= 2 && t.length <= 40);
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 5).join(",");
}
