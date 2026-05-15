#!/usr/bin/env -S npx tsx
// One-shot seed for Threads handles. Pulls up to N (default 100) posts per
// handle by paginating threads.com's GraphQL endpoint, runs each through the
// LLM github resolver, and inserts as candidates.
//
// Pagination is fragile: doc_id rotates ~quarterly, headers/variables drift.
// That's tolerable here because seeding is one-shot - once posts are in the DB,
// the daily fetcher only needs to pick up incremental new ones.
//
// Usage:
//   set -a; . ./.env; set +a
//   npx tsx src/cli/threads-seed.ts <user_id> [handle1,handle2,...] [--cap=100] [--days=30]
//
// For full pagination (~100 posts), set two env vars by capturing values from
// your browser's devtools Network tab while scrolling a Threads profile:
//
//   THREADS_DOC_ID    - value of the "doc_id" form field on a graphql/query POST
//                       whose x-fb-friendly-name is
//                       BarcelonaProfileThreadsTabPaginationDirectFragment
//   THREADS_COOKIE    - full cookie header from the same request
//
// Both rotate; capture fresh ones each time you do a seed run. If unset, the
// CLI falls back to the ~8 posts embedded in the public profile HTML.
//
// Re-running is safe - the (user_id, source, source_item_id) unique constraint
// dedupes existing posts.

import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { resolveGithubFromText, stripHtml } from "../fetchers/resolve-github";
import { resolveUserConfig } from "../scheduler/user-config";
import { parseEmbeddedPosts, type ThreadPost } from "../fetchers/threads-scrape";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

const GRAPHQL_URL = "https://www.threads.com/graphql/query";
const FRIENDLY_NAME = "BarcelonaProfileThreadsTabPaginationDirectFragment";

type ProfileCtx = {
  handle: string;
  userId: string | null;
  lsd: string | null;
  docId: string | null;
  embeddedPosts: ThreadPost[];
};

// ─────────────────────────────────────────────────────────────
// Stage 1: load profile HTML, extract everything we need
// ─────────────────────────────────────────────────────────────

async function loadProfileContext(handle: string): Promise<ProfileCtx> {
  const url = `https://www.threads.com/@${encodeURIComponent(handle)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": MOBILE_UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.5",
      ...(process.env.THREADS_COOKIE ? { cookie: process.env.THREADS_COOKIE } : {}),
    },
  });
  if (!res.ok) {
    console.warn(`[seed] ${handle} HTTP ${res.status}`);
    return { handle, userId: null, lsd: null, docId: null, embeddedPosts: [] };
  }
  const html = await res.text();
  return {
    handle,
    userId: extractUserId(html),
    lsd: extractLsd(html),
    docId: extractDocId(html),
    embeddedPosts: parseEmbeddedPosts(html),
  };
}

function extractUserId(html: string): string | null {
  // Threads embeds the profile owner's pk multiple times. The most reliable
  // marker is "user_id":"<digits>" or "props":{"user":{"pk":"<digits>"}}.
  const m =
    html.match(/"user_id":"(\d{6,20})"/) ||
    html.match(/"pk":"(\d{6,20})"[^}]*"username":"/) ||
    html.match(/"profile_pic_url"[^}]*"pk":"(\d{6,20})"/);
  return m?.[1] ?? null;
}

function extractLsd(html: string): string | null {
  const m =
    html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/) ||
    html.match(/name="lsd"\s+value="([^"]+)"/);
  return m?.[1] ?? null;
}

function extractDocId(html: string): string | null {
  // Most reliable: env override. Capture it once from devtools (Network tab,
  // filter for "graphql", look at the form-data "doc_id" field for the
  // BarcelonaProfileThreadsTabPaginationDirectFragment request).
  if (process.env.THREADS_DOC_ID) return process.env.THREADS_DOC_ID;
  // Otherwise scan the HTML - Threads usually lazy-loads the doc_id, so this
  // often misses, but try anyway.
  const idx = html.indexOf(FRIENDLY_NAME);
  if (idx >= 0) {
    const window = html.slice(Math.max(0, idx - 1200), idx + 1200);
    const m = window.match(/"(\d{14,20})"/);
    if (m) return m[1];
  }
  const any = html.match(/"doc_id":"(\d{14,20})"/);
  return any?.[1] ?? null;
}

// parseEmbeddedPosts is shared with the daily fetcher - see ../fetchers/threads-scrape.ts

// ─────────────────────────────────────────────────────────────
// Stage 2: paginate via GraphQL
// ─────────────────────────────────────────────────────────────

async function paginateGraphql(
  ctx: ProfileCtx,
  cap: number,
  minTakenAt: number
): Promise<{ posts: ThreadPost[]; ok: boolean; reason?: string }> {
  if (!ctx.userId || !ctx.lsd || !ctx.docId) {
    return {
      posts: [],
      ok: false,
      reason: `missing context: userId=${!!ctx.userId} lsd=${!!ctx.lsd} docId=${!!ctx.docId}`,
    };
  }
  const seen = new Map<string, ThreadPost>();
  for (const p of ctx.embeddedPosts) seen.set(p.code, p);

  let cursor: string | null = null;
  let pages = 0;
  // Threads checks x-csrftoken against the csrftoken cookie. Without this the
  // graphql endpoint returns 403 even with a valid session.
  const csrfMatch = process.env.THREADS_COOKIE?.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  const csrftoken = csrfMatch?.[1];

  while (seen.size < cap && pages < 20) {
    const variables = JSON.stringify({
      after: cursor,
      before: null,
      first: 25,
      last: null,
      userID: ctx.userId,
      __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: !!process.env.THREADS_COOKIE,
    });
    const body = new URLSearchParams({
      lsd: ctx.lsd,
      variables,
      doc_id: ctx.docId,
      fb_api_caller_class: "RelayModern",
      server_timestamps: "true",
    });
    let res: Response;
    try {
      res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": MOBILE_UA,
          "x-ig-app-id": "238260118697367",
          "x-fb-friendly-name": FRIENDLY_NAME,
          "x-fb-lsd": ctx.lsd,
          "x-asbd-id": "129477",
          accept: "*/*",
          referer: `https://www.threads.com/@${ctx.handle}`,
          origin: "https://www.threads.com",
          ...(csrftoken ? { "x-csrftoken": csrftoken } : {}),
          ...(process.env.THREADS_COOKIE ? { cookie: process.env.THREADS_COOKIE } : {}),
        },
        body: body.toString(),
      });
    } catch (e) {
      return { posts: [...seen.values()], ok: false, reason: `fetch error: ${(e as any)?.message ?? e}` };
    }
    if (!res.ok) {
      return { posts: [...seen.values()], ok: false, reason: `HTTP ${res.status}` };
    }
    const json = (await res.json().catch(() => null)) as any;
    if (!json) return { posts: [...seen.values()], ok: false, reason: "non-JSON body" };

    const { posts: pagePosts, nextCursor, hasNext } = extractPostsFromGraphql(json);
    if (pagePosts.length === 0) {
      return { posts: [...seen.values()], ok: hasNext === false, reason: "empty page" };
    }
    let stopForAge = false;
    for (const p of pagePosts) {
      if (p.taken_at && p.taken_at < minTakenAt) { stopForAge = true; continue; }
      if (!seen.has(p.code)) seen.set(p.code, p);
    }
    pages++;
    if (stopForAge) return { posts: [...seen.values()], ok: true };
    if (!hasNext || !nextCursor) return { posts: [...seen.values()], ok: true };
    cursor = nextCursor;
    await new Promise((r) => setTimeout(r, 600));
  }
  return { posts: [...seen.values()], ok: true };
}

function extractPostsFromGraphql(json: any): { posts: ThreadPost[]; nextCursor: string | null; hasNext: boolean | null } {
  const posts: ThreadPost[] = [];
  // The shape varies - walk and collect anything looking like a post node.
  const stack: any[] = [json];
  let nextCursor: string | null = null;
  let hasNext: boolean | null = null;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.code && typeof node.code === "string" && (node.caption || node.text_post_app_info || node.taken_at)) {
      const code = node.code as string;
      const text =
        (typeof node.caption === "object" && typeof node.caption?.text === "string" && node.caption.text) ||
        (typeof node.text === "string" && node.text) ||
        "";
      const taken_at = typeof node.taken_at === "number" ? node.taken_at : null;
      if (text) posts.push({ code, text, taken_at });
    }
    if (node.end_cursor && typeof node.end_cursor === "string") nextCursor = node.end_cursor;
    if (typeof node.has_next_page === "boolean") hasNext = node.has_next_page;
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return { posts, nextCursor, hasNext };
}

// ─────────────────────────────────────────────────────────────
// Stage 3: persist posts as candidates
// ─────────────────────────────────────────────────────────────

async function persistPost(userId: number, handle: string, post: ThreadPost): Promise<boolean> {
  const cleanText = stripHtml(post.text);
  let githubUrl: string | null = null;
  const direct = cleanText.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i);
  if (direct) {
    githubUrl = direct[0];
  } else {
    const resolved = await resolveGithubFromText(cleanText);
    if (resolved) githubUrl = resolved.url;
  }
  if (!githubUrl) return false;
  const postedAt = post.taken_at ? new Date(post.taken_at * 1000) : null;
  const result = await db
    .insert(schema.candidates)
    .values({
      userId,
      source: `threads:${handle}`,
      sourceItemId: post.code,
      title: cleanText.split("\n")[0]?.slice(0, 160) || handle,
      url: `https://www.threads.com/t/${post.code}`,
      githubUrl,
      author: handle,
      score: null,
      postedAt,
      fetchedAt: new Date(),
      rawJson: JSON.stringify(post),
    })
    .onConflictDoNothing({ target: [schema.candidates.userId, schema.candidates.source, schema.candidates.sourceItemId] });
  return result.rowsAffected > 0;
}

async function seedHandle(
  userId: number,
  handle: string,
  cap: number,
  days: number
): Promise<{ seen: number; gh: number; inserted: number; via: string }> {
  const ctx = await loadProfileContext(handle);
  const minTakenAt = Math.floor(Date.now() / 1000) - days * 86400;
  const pag = await paginateGraphql(ctx, cap, minTakenAt);
  let via = "embedded";
  let posts = ctx.embeddedPosts;
  if (pag.ok && pag.posts.length > ctx.embeddedPosts.length) {
    posts = pag.posts;
    via = `graphql (${pag.posts.length})`;
  } else if (!pag.ok) {
    console.warn(`  ${handle}: graphql failed - ${pag.reason}; falling back to embedded`);
  }
  let gh = 0, inserted = 0;
  for (const p of posts) {
    if (p.taken_at && p.taken_at < minTakenAt) continue;
    const ok = await persistPost(userId, handle, p);
    if (ok) { gh++; inserted++; } else {
      // try to detect github presence even when not inserted (dedup case)
      const c = stripHtml(p.text);
      if (/github\.com\/[\w.-]+\/[\w.-]+/i.test(c)) gh++;
    }
  }
  return { seen: posts.length, gh, inserted, via };
}

// ─────────────────────────────────────────────────────────────
// CLI entry
// ─────────────────────────────────────────────────────────────

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
  console.error("usage: threads-seed <user_id> [handles_comma_separated] [--cap=100] [--days=30]");
  process.exit(1);
}
const cap = Math.max(1, Math.min(500, Number(flags.cap ?? 100)));
const days = Math.max(1, Math.min(365, Number(flags.days ?? 30)));

const cfg = await resolveUserConfig(userId);
const cliHandles = positional[1]?.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
const handles =
  cliHandles && cliHandles.length > 0
    ? cliHandles
    : cfg.threadsHandles.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);

if (handles.length === 0) {
  console.error("no handles to seed (configure in /settings or pass on CLI)");
  process.exit(1);
}

console.log(`[seed] user=${userId} handles=${handles.join(",")} cap=${cap} days=${days}`);
console.log(`[seed] doc_id=${process.env.THREADS_DOC_ID ? "set (env)" : "unset"} cookie=${process.env.THREADS_COOKIE ? "yes" : "no"}`);
if (!process.env.THREADS_DOC_ID) {
  console.log(`[seed] without THREADS_DOC_ID, pagination will likely fall back to ~8 embedded posts per handle.`);
  console.log(`[seed] capture doc_id from devtools (see file header) and re-run for full backfill.`);
}
let totalSeen = 0, totalGh = 0, totalInserted = 0;
for (const h of handles) {
  try {
    const r = await seedHandle(userId, h, cap, days);
    console.log(`  ${h}: ${r.seen} posts via ${r.via}, ${r.gh} with github, ${r.inserted} new`);
    totalSeen += r.seen;
    totalGh += r.gh;
    totalInserted += r.inserted;
  } catch (e) {
    console.error(`  ${h}: failed`, (e as any)?.message ?? e);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`[seed] done. total: ${totalSeen} posts seen, ${totalGh} with github, ${totalInserted} new candidates`);

void eq;
process.exit(0);
