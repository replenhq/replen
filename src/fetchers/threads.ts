import type { Fetcher, FetchedCandidate } from "./types";
import { extractGithubRepos } from "../lib/github-url";
import { resolveGithubFromText, stripHtml } from "./resolve-github";

// Threads fetcher.
//
// We tried direct HTML scraping in May 2026 - threads.com no longer
// server-renders post bodies, so a plain curl only gets profile metadata.
// RSSHub's /threads/:user route has its own scrape implementation that still
// works, so we depend on a running RSSHub instance pointed to by RSSHUB_BASE.
//
// Run your own RSSHub with:
//   docker run -d --name rsshub -p 127.0.0.1:1200:1200 diygod/rsshub:latest
// and set RSSHUB_BASE=http://127.0.0.1:1200 in .env. Or point at a hosted
// instance you trust.

export const threadsFetcher: Fetcher = {
  name: "threads",
  async run() {
    const base = process.env.RSSHUB_BASE;
    const handles = (process.env.THREADS_HANDLES ?? "")
      .split(",")
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);
    if (!base || handles.length === 0) return [];

    const out: FetchedCandidate[] = [];
    for (const handle of handles) {
      const url = `${base.replace(/\/$/, "")}/threads/${encodeURIComponent(handle)}`;
      let xml: string;
      try {
        const res = await fetch(url, { headers: { "user-agent": "replen/0.1" } });
        if (!res.ok) {
          console.warn(`[threads] ${handle} -> ${res.status}`);
          continue;
        }
        xml = await res.text();
      } catch (e) {
        console.warn(`[threads] ${handle} fetch error`, e);
        continue;
      }

      for (const item of parseRssItems(xml)) {
        const cleanText = stripHtml(`${item.title}\n${item.description}`);
        let githubUrl = extractGithubRepos(cleanText)[0]?.url ?? null;
        if (!githubUrl) {
          const resolved = await resolveGithubFromText(cleanText);
          if (resolved) {
            githubUrl = resolved.url;
            console.log(`[threads] resolved @${handle}: "${cleanText.slice(0, 60)}..." -> ${githubUrl} (${resolved.matchedVia})`);
          }
        }
        if (!githubUrl) continue;
        out.push({
          source: `threads:${handle}`,
          sourceItemId: item.guid || item.link,
          title: cleanText.split("\n")[0]?.slice(0, 160) || handle,
          url: item.link,
          githubUrl,
          author: handle,
          score: null,
          postedAt: item.pubDate,
          raw: item,
        });
      }
    }
    return out;
  },
};

type RssItem = { title: string; link: string; guid: string; pubDate: Date | null; description: string };

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    items.push({
      title: pick(block, "title"),
      link: pick(block, "link"),
      guid: pick(block, "guid"),
      description: pick(block, "description"),
      pubDate: (() => {
        const s = pick(block, "pubDate");
        const d = s ? new Date(s) : null;
        return d && !isNaN(d.getTime()) ? d : null;
      })(),
    });
  }
  return items;
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}
