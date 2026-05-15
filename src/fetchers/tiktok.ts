import type { Fetcher, FetchedCandidate } from "./types";
import { resolveGithubFromText, stripHtml } from "./resolve-github";

// Direct profile-HTML scraper for TikTok. Avoids RSSHub's tiktok route which
// requires Puppeteer + Chrome (not available in our shared RSSHub container).
//
// TikTok renders the profile page with a JSON blob inside a
// <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> tag containing the user's
// most recent ~30 videos. We extract each {id, desc, createTime} triple, run
// resolveGithubFromText on the caption to identify a candidate repo.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15";

type TTPost = { id: string; desc: string; createTime: number | null };

async function fetchProfile(handle: string): Promise<TTPost[]> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.5",
        ...(process.env.TIKTOK_COOKIE ? { cookie: process.env.TIKTOK_COOKIE } : {}),
      },
    });
    if (!res.ok) {
      console.warn(`[tiktok] ${handle} -> ${res.status}`);
      return [];
    }
    html = await res.text();
  } catch (e) {
    console.warn(`[tiktok] ${handle} fetch error`, e);
    return [];
  }
  return parseEmbedded(html);
}

function parseEmbedded(html: string): TTPost[] {
  // Primary path: the universal-data script tag carries a clean JSON tree.
  const m = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const posts = walkForPosts(data);
      if (posts.length > 0) return posts;
    } catch {}
  }
  // Fallback: regex pairs of "id":"<digits>" + "desc":"..." nearby.
  return regexFallback(html);
}

function walkForPosts(root: any): TTPost[] {
  const out: TTPost[] = [];
  const seen = new Set<string>();
  const stack: any[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (
      typeof node.id === "string" &&
      /^\d{15,21}$/.test(node.id) &&
      typeof node.desc === "string" &&
      !seen.has(node.id)
    ) {
      seen.add(node.id);
      out.push({
        id: node.id,
        desc: node.desc,
        createTime: typeof node.createTime === "number" ? node.createTime : null,
      });
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
}

function regexFallback(html: string): TTPost[] {
  const byId = new Map<string, TTPost>();
  const re = /"id":"(\d{15,21})"[\s\S]{0,4000}?"desc":"((?:[^"\\]|\\.){0,2000})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (byId.has(m[1])) continue;
    let desc = m[2];
    try { desc = JSON.parse(`"${desc}"`); } catch {}
    byId.set(m[1], { id: m[1], desc, createTime: null });
  }
  return [...byId.values()];
}

export const tiktokFetcher: Fetcher = {
  name: "tiktok",
  async run() {
    const handles = (process.env.TIKTOK_HANDLES ?? "")
      .split(",")
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);
    if (handles.length === 0) return [];

    const out: FetchedCandidate[] = [];
    for (const handle of handles) {
      const posts = await fetchProfile(handle);
      console.log(`[tiktok] ${handle}: ${posts.length} posts seen`);
      for (const p of posts) {
        const cleanText = stripHtml(p.desc);
        let githubUrl: string | null = null;
        const direct = cleanText.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i);
        if (direct) {
          githubUrl = direct[0];
        } else {
          const resolved = await resolveGithubFromText(cleanText);
          if (resolved) {
            githubUrl = resolved.url;
            console.log(`[tiktok] resolved @${handle}: "${cleanText.slice(0, 60)}..." -> ${githubUrl} (${resolved.matchedVia})`);
          }
        }
        if (!githubUrl) continue;
        out.push({
          source: `tiktok:${handle}`,
          sourceItemId: p.id,
          title: cleanText.split("\n")[0]?.slice(0, 160) || handle,
          url: `https://www.tiktok.com/@${handle}/video/${p.id}`,
          githubUrl,
          author: handle,
          score: null,
          postedAt: p.createTime ? new Date(p.createTime * 1000) : null,
          raw: p,
        });
      }
      // Be polite — 1.5s gap so we don't get rate-limited by tiktok.com.
      await new Promise((r) => setTimeout(r, 1500));
    }
    return out;
  },
};
