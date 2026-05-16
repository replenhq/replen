#!/usr/bin/env -S npx tsx
// One-shot TikTok seed. Scrapes a public profile page, pulls embedded video
// metadata from __UNIVERSAL_DATA_FOR_REHYDRATION__, resolves caption text to
// GitHub repos via the same LLM resolver used elsewhere, and inserts each as a
// candidate.
//
// Usage:
//   set -a; . ./.env; set +a
//   npx tsx src/cli/tiktok-seed.ts <user_id> [handles_csv] [--cap=50] [--days=30]
//
// Public profiles return ~30 videos in the initial HTML; that's usually enough
// for a seed. Re-running is idempotent thanks to (user_id, source, source_item_id)
// uniqueness on candidates.

import { db, schema } from "../db/client";
import { resolveGithubFromText, stripHtml } from "../fetchers/resolve-github";
import { resolveUserConfig } from "../scheduler/user-config";
import { errorMsg } from "../lib/error-msg";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15";

type TTPost = { id: string; desc: string; createTime: number | null };

async function fetchProfile(handle: string): Promise<TTPost[]> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.5",
      ...(process.env.TIKTOK_COOKIE ? { cookie: process.env.TIKTOK_COOKIE } : {}),
    },
  });
  if (!res.ok) {
    console.warn(`[tiktok-seed] ${handle} HTTP ${res.status}`);
    return [];
  }
  const html = await res.text();
  return parseEmbedded(html);
}

function parseEmbedded(html: string): TTPost[] {
  // TikTok injects a single JSON blob with all profile data into a script tag
  // with id="__UNIVERSAL_DATA_FOR_REHYDRATION__". We extract the video list
  // from it via JSON.parse instead of regexing through the entire bundle.
  const m = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) {
    // Fallback: regex out id + desc fields from anywhere in the HTML.
    return regexFallback(html);
  }
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return regexFallback(html);
  }
  const posts: TTPost[] = [];
  const stack: any[] = [data];
  const seenIds = new Set<string>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (typeof node.id === "string" && /^\d{15,21}$/.test(node.id) && typeof node.desc === "string") {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id);
        posts.push({
          id: node.id,
          desc: node.desc,
          createTime: typeof node.createTime === "number" ? node.createTime : null,
        });
      }
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return posts;
}

function regexFallback(html: string): TTPost[] {
  const byId = new Map<string, TTPost>();
  const idRe = /"id":"(\d{15,21})"[\s\S]{0,4000}?"desc":"((?:[^"\\]|\\.){0,2000})"/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(html))) {
    if (byId.has(m[1])) continue;
    let desc = m[2];
    try { desc = JSON.parse(`"${desc}"`); } catch {}
    byId.set(m[1], { id: m[1], desc, createTime: null });
  }
  return [...byId.values()];
}

async function persist(userId: number, handle: string, p: TTPost): Promise<boolean> {
  const cleanText = stripHtml(p.desc);
  let githubUrl: string | null = null;
  const direct = cleanText.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i);
  if (direct) {
    githubUrl = direct[0];
  } else {
    const resolved = await resolveGithubFromText(cleanText);
    if (resolved) githubUrl = resolved.url;
  }
  if (!githubUrl) return false;
  const postedAt = p.createTime ? new Date(p.createTime * 1000) : null;
  const result = await db
    .insert(schema.candidates)
    .values({
      userId,
      source: `tiktok:${handle}`,
      sourceItemId: p.id,
      title: cleanText.split("\n")[0]?.slice(0, 160) || handle,
      url: `https://www.tiktok.com/@${handle}/video/${p.id}`,
      githubUrl,
      author: handle,
      score: null,
      postedAt,
      fetchedAt: new Date(),
      rawJson: JSON.stringify(p),
    })
    .onConflictDoNothing({ target: [schema.candidates.userId, schema.candidates.source, schema.candidates.sourceItemId] });
  return result.rowsAffected > 0;
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const userId = Number(positional[0]);
if (!Number.isFinite(userId)) {
  console.error("usage: tiktok-seed <user_id> [handles_comma_separated] [--cap=50] [--days=30]");
  process.exit(1);
}
const cap = Math.max(1, Math.min(500, Number(flags.cap ?? 50)));
const days = Math.max(1, Math.min(365, Number(flags.days ?? 30)));

const cfg = await resolveUserConfig(userId);
const cliHandles = positional[1]?.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
const handles =
  cliHandles && cliHandles.length > 0
    ? cliHandles
    : cfg.tiktokHandles.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);

if (handles.length === 0) {
  console.error("no handles to seed (configure in /settings or pass on CLI)");
  process.exit(1);
}

console.log(`[tiktok-seed] user=${userId} handles=${handles.join(",")} cap=${cap} days=${days}`);
const minCreate = Math.floor(Date.now() / 1000) - days * 86400;
let totalSeen = 0, totalGh = 0, totalInserted = 0;
for (const h of handles) {
  try {
    const posts = (await fetchProfile(h)).slice(0, cap);
    let gh = 0, inserted = 0;
    for (const p of posts) {
      if (p.createTime && p.createTime < minCreate) continue;
      const ok = await persist(userId, h, p);
      if (ok) { gh++; inserted++; } else if (/github\.com\/[\w.-]+\/[\w.-]+/i.test(stripHtml(p.desc))) gh++;
    }
    console.log(`  ${h}: ${posts.length} posts seen, ${gh} with github, ${inserted} new`);
    totalSeen += posts.length;
    totalGh += gh;
    totalInserted += inserted;
  } catch (e) {
    console.error(`  ${h}: failed`, errorMsg(e));
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`[tiktok-seed] done. total: ${totalSeen} seen, ${totalGh} with github, ${totalInserted} new`);
process.exit(0);
