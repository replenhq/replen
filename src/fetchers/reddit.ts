import * as cheerio from "cheerio";
import type { Fetcher, FetchedCandidate } from "./types";
import { extractGithubRepos } from "../lib/github-url";
import { readRunOrEnv } from "../analyzer/run-context";

// Reddit's /top.json endpoint returns 403 from data-center IPs (OVH, AWS,
// etc.) regardless of User-Agent — Reddit enforces this via IP class even
// for properly-formatted UAs. The /top/.rss endpoint serves the same
// content via the legacy RSS path and is far less aggressively gated.
// Fall back to .json only when an explicit OAuth token is configured.

export const redditFetcher: Fetcher = {
  name: "reddit",
  async run() {
    const subs = (readRunOrEnv("redditSubs", "REDDIT_SUBS") ?? "MachineLearning,LocalLLaMA,selfhosted,programming,opensource")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ua = process.env.REDDIT_USER_AGENT ?? "web:replen.dev:0.1 (by /u/replenhq)";
    const cutoff = Date.now() / 1000 - 36 * 3600;

    const out: FetchedCandidate[] = [];
    for (const sub of subs) {
      const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top/.rss?t=day&limit=50`;
      let xml: string;
      try {
        const res = await fetch(url, {
          headers: {
            "user-agent": ua,
            accept: "application/atom+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        if (!res.ok) {
          console.warn(`[reddit] ${sub} -> ${res.status} (rss)`);
          continue;
        }
        xml = await res.text();
      } catch (e) {
        console.warn(`[reddit] ${sub} fetch error`, e);
        continue;
      }

      // Reddit's RSS is Atom-flavoured. Each <entry> carries the thread
      // title + content (HTML, where external links live) + a permalink
      // back to the reddit thread.
      const $ = cheerio.load(xml, { xml: true });
      let kept = 0;
      $("entry").each((_, el) => {
        const $e = $(el);
        const title = $e.find("title").first().text().trim();
        const permalink = $e.find("link").first().attr("href") ?? "";
        const id = $e.find("id").first().text().trim(); // "t3_xyz" or full URL
        const sourceItemId = id.startsWith("t3_") ? id.slice(3) : id.split("/").filter(Boolean).pop() ?? id;
        const author = $e.find("author > name").first().text().trim() || null;
        const updated = $e.find("updated").first().text().trim();
        const postedAt = updated ? new Date(updated) : null;
        if (postedAt && postedAt.getTime() / 1000 < cutoff) return;
        const contentHtml = $e.find("content").first().text();

        // Pull github.com URLs out of the HTML content. The content also
        // includes the [link] href if the OP shared an external URL.
        const probe = `${title} ${contentHtml}`;
        const repos = extractGithubRepos(probe);
        if (repos.length === 0) return;
        const githubUrl = repos[0].url;

        out.push({
          source: `reddit:${sub}`,
          sourceItemId,
          title,
          url: permalink || `https://reddit.com/comments/${sourceItemId}`,
          githubUrl,
          author,
          score: null, // RSS doesn't expose upvotes; OK without
          postedAt,
          raw: { sub, id, title, permalink, githubUrl, updated },
        });
        kept++;
      });
      console.log(`[reddit] ${sub}: rss kept ${kept}`);
    }
    return out;
  },
};
