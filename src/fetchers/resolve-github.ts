// For posts that describe an OSS project without a direct github.com link
// (typical of Threads/Instagram), use the LLM to extract a likely identity
// and confirm against GitHub's repo search.

import { chatCompletion, TRIAGE_MODEL } from "../analyzer/llm";

type Resolution = {
  url: string;
  owner: string;
  name: string;
  stars: number;
  description: string | null;
  matchedVia: "guess" | "search";
};

const ghHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { "user-agent": "replen/0.1", accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
};

export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function resolveGithubFromText(text: string): Promise<Resolution | null> {
  const clean = stripHtml(text).slice(0, 1500);
  if (!/open[- ]source|github|repo|library|tool|model|framework|cli|sdk/i.test(clean)) {
    return null; // looks like an off-topic post (e.g. a viral science clip)
  }

  let extracted: { name: string | null; owner_guess: string | null; repo_guess: string | null; search_query: string | null };
  try {
    const res = await chatCompletion(
      {
        model: TRIAGE_MODEL,
        max_tokens: 512,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'The post discusses an open-source project. Identify it. Output JSON ONLY: {"name":"<project name or null>","owner_guess":"<github owner or null>","repo_guess":"<github repo or null>","search_query":"<3-6 word query that would find this repo on GitHub, or null>"}. If the post is not about a discoverable open-source project, set all fields to null.',
          },
          { role: "user", content: clean },
        ],
      },
      { timeoutMs: 45_000, retries: 1 }
    );
    const txt = res.choices[0]?.message?.content ?? "{}";
    const j = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    extracted = {
      name: j.name ?? null,
      owner_guess: j.owner_guess ?? null,
      repo_guess: j.repo_guess ?? null,
      search_query: j.search_query ?? null,
    };
  } catch (e) {
    console.warn("[resolve-gh] LLM extraction failed", e);
    return null;
  }

  // 1) Try direct owner/repo guess
  if (extracted.owner_guess && extracted.repo_guess) {
    const candidate = await tryRepo(extracted.owner_guess, extracted.repo_guess);
    if (candidate) return { ...candidate, matchedVia: "guess" };
  }

  // 2) Search GitHub
  if (extracted.search_query) {
    const q = encodeURIComponent(extracted.search_query);
    const res = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=5`, {
      headers: ghHeaders(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: any[] };
    const top = data.items?.[0];
    if (!top) return null;
    return {
      url: top.html_url,
      owner: top.owner?.login ?? "",
      name: top.name ?? "",
      stars: top.stargazers_count ?? 0,
      description: top.description ?? null,
      matchedVia: "search",
    };
  }

  return null;
}

async function tryRepo(owner: string, name: string) {
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    headers: ghHeaders(),
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  return {
    url: j.html_url as string,
    owner: j.owner?.login as string,
    name: j.name as string,
    stars: j.stargazers_count as number,
    description: (j.description as string | null) ?? null,
  };
}
