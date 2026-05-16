import type { Fetcher, FetchedCandidate } from "./types";
import { extractGithubRepos } from "../lib/github-url";
import { readRunOrEnv } from "../analyzer/run-context";

type RedditPost = {
  data: {
    id: string;
    title: string;
    url: string;
    permalink: string;
    author: string;
    score: number;
    selftext: string;
    created_utc: number;
    subreddit: string;
  };
};

export const redditFetcher: Fetcher = {
  name: "reddit",
  async run() {
    const subs = (readRunOrEnv("redditSubs", "REDDIT_SUBS") ?? "MachineLearning,LocalLLaMA,selfhosted,programming,opensource")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ua = process.env.REDDIT_USER_AGENT ?? "replen/0.1";

    const out: FetchedCandidate[] = [];
    const cutoff = Date.now() / 1000 - 36 * 3600;

    for (const sub of subs) {
      const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=day&limit=50`;
      const res = await fetch(url, { headers: { "user-agent": ua } });
      if (!res.ok) {
        console.warn(`[reddit] ${sub} -> ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { data: { children: RedditPost[] } };
      for (const p of json.data.children) {
        const d = p.data;
        if (d.created_utc < cutoff) continue;
        const probe = `${d.title} ${d.url} ${d.selftext}`;
        const repos = extractGithubRepos(probe);
        const githubUrl = repos[0]?.url ?? (d.url.includes("github.com") ? d.url : null);
        if (!githubUrl) continue;
        out.push({
          source: `reddit:${sub}`,
          sourceItemId: d.id,
          title: d.title,
          url: `https://reddit.com${d.permalink}`,
          githubUrl,
          author: d.author,
          score: d.score,
          postedAt: new Date(d.created_utc * 1000),
          raw: d,
        });
      }
    }
    return out;
  },
};
