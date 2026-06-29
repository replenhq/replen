// `npx replen immerse` — hosted Immersion sender (M2).
//
// On the hosted service Replen can't read your disk, so to ground matching on
// your actual code you opt in and this command does the transmit: for each
// tracked repo it asks the server which grounded files to send (the manifest),
// reads exactly those files locally, and POSTs them to the ingest endpoint —
// which embeds them and keeps ONLY the vectors, discarding the source. Nothing
// is read or sent for a repo whose tier is off.
//
//   npx replen immerse on       opt in (vectors-only) + send now
//   npx replen immerse          send for an already-opted-in account
//   npx replen immerse status   show the account default
//   npx replen immerse off      opt out
//
// Self-host installs don't need this — they default on via REPLEN_SELF_HOST and
// the pipeline reads local disk directly.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfigOrExit, apiGet, apiPost } from "./api.js";
import { resolveAndWalk } from "./sync-projects.js";
import type { Config } from "./config.js";

const MAX_FILE_BYTES = 1_000_000; // mirror the server per-file cap

type Manifest = { tier: string; paths: string[]; storedCodeHash: string | null };
type IngestResult = { ok: boolean; unchanged: boolean; filesEmbedded?: number; chunksEmbedded?: number; skipped?: string };

export async function runImmerse(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? "").toLowerCase();
  const cfg = await loadConfigOrExit();

  if (sub === "status") {
    const { tier } = await apiGet<{ tier: string }>(cfg, "/api/settings/immersion");
    console.log(`Immersion (account default): ${tier}`);
    if (tier === "off") console.log("Run `npx replen immerse on` to enable it. Your code is embedded, then discarded — only vectors are kept.");
    return;
  }

  if (sub === "off") {
    await apiPost(cfg, "/api/settings/immersion", { tier: "off" });
    console.log("Immersion turned OFF for your account. Existing code vectors are dropped on the next run.");
    return;
  }

  if (sub === "on") {
    await apiPost(cfg, "/api/settings/immersion", { tier: "embeddings" });
    console.log("Immersion ON (vectors-only). Your code is embedded server-side and the source discarded — only the vectors persist.\n");
    await send(cfg);
    return;
  }

  // No subcommand: send for an already-opted-in account.
  const { tier } = await apiGet<{ tier: string }>(cfg, "/api/settings/immersion");
  if (tier === "off") {
    console.log("Immersion is off for your account. Run `npx replen immerse on` to enable it (vectors-only — your code is embedded, then discarded).");
    return;
  }
  await send(cfg);
}

// Discover local repos, then for each tracked + opted-in repo: fetch the
// manifest, read the listed files, and ingest them.
async function send(cfg: Config): Promise<void> {
  console.log("Scanning local repos…");
  const { result } = await resolveAndWalk([]);
  const repos = result.projects.filter((p) => p.githubFullName && p.localPath);
  if (repos.length === 0) {
    console.log("  · No local git repos with GitHub remotes found. Nothing to send.");
    return;
  }

  let grounded = 0, totalFiles = 0, totalChunks = 0, unchanged = 0;
  for (const repo of repos) {
    let manifest: Manifest;
    try {
      manifest = await apiPost<Manifest>(cfg, "/api/immersion/manifest", { githubFullName: repo.githubFullName });
    } catch {
      continue; // not tracked on this account (404) / transient — skip quietly
    }
    if (manifest.tier === "off" || !Array.isArray(manifest.paths) || manifest.paths.length === 0) continue;

    // Read exactly the grounded files the server asked for (size-capped).
    const files: Array<{ rel: string; content: string }> = [];
    for (const rel of manifest.paths) {
      try {
        const abs = join(repo.localPath, rel);
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
        const content = readFileSync(abs, "utf8");
        if (content.trim()) files.push({ rel, content });
      } catch {
        /* file gone / unreadable — skip */
      }
    }
    if (files.length === 0) continue;

    let res: IngestResult;
    try {
      res = await apiPost<IngestResult>(cfg, "/api/immersion/ingest", { githubFullName: repo.githubFullName, files });
    } catch (e) {
      console.warn(`  ✗ ${repo.githubFullName}: ${(e as Error).message}`);
      continue;
    }
    if (res.unchanged) { unchanged++; continue; }
    grounded++;
    totalFiles += res.filesEmbedded ?? 0;
    totalChunks += res.chunksEmbedded ?? 0;
    console.log(`  ✓ ${repo.githubFullName}: ${res.chunksEmbedded ?? 0} chunk(s) from ${res.filesEmbedded ?? 0} file(s)`);
  }

  const parts: string[] = [];
  if (grounded > 0) parts.push(`grounded ${grounded} repo(s) — ${totalChunks} chunk(s) from ${totalFiles} file(s)`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  console.log(`\nImmersion: ${parts.length ? parts.join(", ") : "nothing to update"}.`);
}
