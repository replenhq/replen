#!/usr/bin/env -S npx tsx
// Manual ingest for Threads posts you've copy-pasted from the browser.
// Useful when GraphQL pagination is broken (which it usually is — Meta's
// signed-request layer rotates constantly).
//
// Splits the paste on DD/MM/YYYY date lines, treats each chunk as one post,
// runs the caption through resolveGithubFromText, inserts as a candidate.
//
// Usage:
//   set -a; . ./.env; set +a
//   pbpaste | npx tsx src/cli/threads-paste.ts <user_id> <handle>
// or
//   npx tsx src/cli/threads-paste.ts <user_id> <handle> < path/to/posts.txt

import { createHash } from "node:crypto";
import { db, schema } from "../db/client";
import { resolveGithubFromText, stripHtml } from "../fetchers/resolve-github";

const userId = Number(process.argv[2]);
const handle = (process.argv[3] ?? "").trim().replace(/^@/, "");
if (!Number.isFinite(userId) || !handle) {
  console.error("usage: pbpaste | threads-paste <user_id> <handle>");
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
if (!raw.trim()) {
  console.error("no stdin content. did you pipe the paste in?");
  process.exit(1);
}

// Split on a date line (DD/MM/YYYY). Each chunk = one post.
// Strip trailing copyright / footer junk.
const dateRe = /(?:^|\n)\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*(?=\n)/g;
const splits: { date: string; body: string }[] = [];
let lastIdx = 0;
let lastDate: string | null = null;
let m: RegExpExecArray | null;
while ((m = dateRe.exec(raw))) {
  if (lastDate !== null) {
    const body = raw.slice(lastIdx, m.index).trim();
    if (body) splits.push({ date: lastDate, body });
  }
  lastDate = m[1];
  lastIdx = m.index + m[0].length;
}
if (lastDate !== null) {
  const body = raw.slice(lastIdx).trim();
  if (body) splits.push({ date: lastDate, body });
}

if (splits.length === 0) {
  console.error("no posts found — expected lines with DD/MM/YYYY date markers");
  process.exit(1);
}

console.log(`[paste] found ${splits.length} posts for @${handle}`);

let inserted = 0;
let withGh = 0;
for (const { date, body } of splits) {
  // Drop trailing footer/copyright lines.
  const cleanBody = body
    .replace(/^©\s+\d{4}[\s\S]*$/m, "")
    .replace(/^(?:Threads Terms|Privacy Policy|Cookies Policy)[\s\S]*$/m, "")
    .trim();
  if (!cleanBody) continue;

  const text = stripHtml(cleanBody);

  // Detect github URL — first try direct, then the LLM resolver.
  let githubUrl: string | null = null;
  const direct = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i);
  if (direct) {
    githubUrl = direct[0];
  } else {
    const resolved = await resolveGithubFromText(text);
    if (resolved) {
      githubUrl = resolved.url;
      console.log(`  resolved: "${text.slice(0, 60)}..." -> ${githubUrl} (${resolved.matchedVia})`);
    } else {
      console.log(`  unresolved: "${text.slice(0, 60)}..."`);
      continue;
    }
  }
  withGh++;

  // Parse DD/MM/YYYY → Date. Threads doesn't expose a time so use noon UTC.
  const [d, mo, y] = date.split("/").map((s) => parseInt(s, 10));
  const postedAt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));

  // Stable sourceItemId so re-running the same paste is idempotent.
  const sourceItemId =
    "paste:" + createHash("sha1").update(`${handle}|${date}|${text.slice(0, 120)}`).digest("hex").slice(0, 16);

  const result = await db
    .insert(schema.candidates)
    .values({
      userId,
      source: `threads:${handle}`,
      sourceItemId,
      title: text.split("\n").find((l) => l.trim() && !/^[🚨🔥👉]/.test(l))?.slice(0, 160) || handle,
      url: `https://www.threads.com/@${handle}`,
      githubUrl,
      author: handle,
      score: null,
      postedAt,
      fetchedAt: new Date(),
      rawJson: JSON.stringify({ date, body: text, via: "paste" }),
    })
    .onConflictDoNothing({ target: [schema.candidates.userId, schema.candidates.source, schema.candidates.sourceItemId] });
  if (result.rowsAffected > 0) {
    inserted++;
    console.log(`  inserted: ${date} → ${githubUrl}`);
  } else {
    console.log(`  duplicate: ${date} → ${githubUrl}`);
  }
}
console.log(`[paste] done. ${splits.length} posts seen, ${withGh} with github, ${inserted} new candidates`);
process.exit(0);
