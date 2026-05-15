import type { Fetcher, FetchedCandidate } from "./types";
import { extractGithubRepos } from "../lib/github-url";

type AlgoliaHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string | null;
  points: number | null;
  story_text: string | null;
  created_at_i: number;
};

export const hnFetcher: Fetcher = {
  name: "hn",
  async run() {
    const since = Math.floor((Date.now() - 36 * 3600 * 1000) / 1000);
    const url =
      `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${since},points>20&hitsPerPage=200`;
    const res = await fetch(url, { headers: { "user-agent": "replen/0.1" } });
    if (!res.ok) throw new Error(`HN fetch failed: ${res.status}`);
    const data = (await res.json()) as { hits: AlgoliaHit[] };

    const out: FetchedCandidate[] = [];
    for (const h of data.hits) {
      const probe = `${h.title ?? ""} ${h.url ?? ""} ${h.story_text ?? ""}`;
      const repos = extractGithubRepos(probe);
      const githubUrl = repos[0]?.url ?? (h.url?.includes("github.com") ? h.url : null);
      out.push({
        source: "hn",
        sourceItemId: h.objectID,
        title: h.title ?? "(untitled)",
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        githubUrl,
        author: h.author,
        score: h.points,
        postedAt: new Date(h.created_at_i * 1000),
        raw: h,
      });
    }
    return out.filter((c) => c.githubUrl);
  },
};
