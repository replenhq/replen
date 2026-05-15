// Shared Threads profile HTML parser. Used by both the daily fetcher
// (src/fetchers/threads.ts) and the one-shot seed CLI (src/cli/threads-seed.ts).
//
// Threads embeds the first ~8 posts directly into the mobile-HTML profile
// page as JSON. We regex out {code, text, taken_at} from each match. The
// exact JSON path changes month-to-month; we deliberately don't rely on it.

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

export type ThreadPost = { code: string; text: string; taken_at: number | null };

export async function fetchHandlePosts(handle: string): Promise<ThreadPost[]> {
  const url = `https://www.threads.com/@${encodeURIComponent(handle)}`;
  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": MOBILE_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.5",
        ...(process.env.THREADS_COOKIE ? { cookie: process.env.THREADS_COOKIE } : {}),
      },
    });
    if (!res.ok) {
      console.warn(`[threads] ${handle} HTTP ${res.status}`);
      return [];
    }
    html = await res.text();
  } catch (e) {
    console.warn(`[threads] ${handle} fetch error`, e);
    return [];
  }
  return parseEmbeddedPosts(html);
}

export function parseEmbeddedPosts(html: string): ThreadPost[] {
  const byCode = new Map<string, ThreadPost>();
  const codeRe = /"code":"([A-Za-z0-9_-]{9,15})"/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(html))) {
    const code = m[1];
    if (code === "en_US") continue;
    if (byCode.has(code)) continue;
    const start = Math.max(0, m.index - 500);
    const end = Math.min(html.length, m.index + 6000);
    const window = html.slice(start, end);
    const textM = window.match(/"text":"((?:[^"\\]|\\.){10,2000})"/);
    const takenM = window.match(/"taken_at":(\d{10,})/);
    if (!textM) continue;
    let text = textM[1];
    try { text = JSON.parse(`"${text}"`); } catch {}
    byCode.set(code, { code, text, taken_at: takenM ? parseInt(takenM[1], 10) : null });
  }
  return [...byCode.values()];
}
