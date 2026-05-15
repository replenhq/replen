#!/usr/bin/env -S node --experimental-strip-types
// digest-sync: walks GITHUB_ROOT (default ~/github), pulls today's writeups from
// the server, writes them into <repo>/.replen/YYYY-MM-DD/<slug>.md. Tracks
// "last sync" timestamp locally.

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

type SyncResponse = {
  since: string;
  projects: { slug: string; writeups: { id: number; repo: string; createdAt: string; markdown: string }[] }[];
};

const STATE_FILE = join(homedir(), ".replen-sync.json");

async function main() {
  const base = process.env.DIGEST_BASE ?? "http://localhost:3030";
  const token = process.env.SYNC_TOKEN ?? "";
  const root = process.env.GITHUB_ROOT ?? join(homedir(), "github");

  const state = await readState();
  const sinceParam = state.lastSyncAt ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const url = `${base.replace(/\/$/, "")}/api/sync?since=${encodeURIComponent(sinceParam)}`;

  console.log(`[sync] fetching since ${sinceParam}`);
  const res = await fetch(url, { headers: token ? { "x-sync-token": token } : {} });
  if (!res.ok) {
    console.error(`[sync] failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as SyncResponse;

  // Build a slug -> local-path map by walking /github/*
  const dirs = await readdir(root, { withFileTypes: true });
  const slugToPath = new Map<string, string>();
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const slug = d.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    slugToPath.set(slug, join(root, d.name));
  }
  // _general bucket lives in the digest-sync state dir
  const generalDir = join(homedir(), ".replen");
  slugToPath.set("_general", generalDir);

  let written = 0;
  for (const proj of data.projects) {
    const repoRoot = slugToPath.get(proj.slug);
    if (!repoRoot) {
      console.warn(`[sync] no local dir for project slug "${proj.slug}", skipping`);
      continue;
    }
    for (const w of proj.writeups) {
      const day = w.createdAt.slice(0, 10);
      const outDir = join(repoRoot, ".replen", day);
      await mkdir(outDir, { recursive: true });
      const file = join(outDir, `${w.repo}.md`);
      // Skip if already written
      try {
        await stat(file);
        continue;
      } catch {}
      await writeFile(file, w.markdown, "utf8");
      written++;
    }
  }

  await writeState({ lastSyncAt: new Date().toISOString() });
  console.log(`[sync] wrote ${written} writeup files`);
}

async function readState(): Promise<{ lastSyncAt?: string }> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(s: { lastSyncAt?: string }) {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
