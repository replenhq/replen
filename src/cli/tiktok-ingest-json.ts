#!/usr/bin/env -S npx tsx
// Ingests a JSON file of TikTok posts produced by the Scraper repo's
// tiktok_backfill.py. Runs each caption through resolveGithubFromText and
// inserts as a candidate. Idempotent via the (user_id, source, source_item_id)
// unique constraint.
//
// Usage:
//   set -a; . ./.env; set +a
//   npx tsx src/cli/tiktok-ingest-json.ts <user_id> /path/to/handle.json
//   npx tsx src/cli/tiktok-ingest-json.ts <user_id> /path/to/dir/   (all *.json)

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { db, schema } from "../db/client";
import { resolveGithubFromText, stripHtml } from "../fetchers/resolve-github";

type Post = {
  id: string;
  handle: string;
  desc: string;
  createTime: number | null;
  url: string;
};

const userId = Number(process.argv[2]);
const path = process.argv[3];
if (!Number.isFinite(userId) || !path) {
  console.error("usage: tiktok-ingest-json <user_id> <file_or_dir>");
  process.exit(1);
}

async function load(p: string): Promise<Post[]> {
  const stats = await stat(p);
  if (stats.isDirectory()) {
    const names = (await readdir(p)).filter((n) => n.endsWith(".json"));
    const out: Post[] = [];
    for (const n of names) {
      const data = JSON.parse(await readFile(join(p, n), "utf8"));
      if (Array.isArray(data)) out.push(...data);
    }
    return out;
  }
  const data = JSON.parse(await readFile(p, "utf8"));
  if (!Array.isArray(data)) throw new Error("expected a JSON array");
  return data;
}

const posts = await load(path);
console.log(`[tt-ingest] ${posts.length} posts loaded from ${path}`);

let withGh = 0;
let inserted = 0;
let skipped = 0;
for (const p of posts) {
  if (!p.id || !p.handle) { skipped++; continue; }
  const text = stripHtml(p.desc ?? "");
  let githubUrl: string | null = null;
  const direct = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i);
  if (direct) {
    githubUrl = direct[0];
  } else if (text.trim()) {
    const resolved = await resolveGithubFromText(text);
    if (resolved) {
      githubUrl = resolved.url;
      console.log(`  resolved @${p.handle}: "${text.slice(0, 60)}..." -> ${githubUrl} (${resolved.matchedVia})`);
    }
  }
  if (!githubUrl) continue;
  withGh++;

  const postedAt = p.createTime ? new Date(p.createTime * 1000) : null;
  const result = await db
    .insert(schema.candidates)
    .values({
      userId,
      source: `tiktok:${p.handle}`,
      sourceItemId: p.id,
      title: text.split("\n")[0]?.slice(0, 160) || p.handle,
      url: p.url || `https://www.tiktok.com/@${p.handle}/video/${p.id}`,
      githubUrl,
      author: p.handle,
      score: null,
      postedAt,
      fetchedAt: new Date(),
      rawJson: JSON.stringify({ ...p, via: "backfill-json" }),
    })
    .onConflictDoNothing({ target: [schema.candidates.userId, schema.candidates.source, schema.candidates.sourceItemId] });
  if (result.rowsAffected > 0) inserted++;
}

console.log(`[tt-ingest] done. ${posts.length} seen, ${withGh} with github, ${inserted} new, ${skipped} skipped`);
process.exit(0);
