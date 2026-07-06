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
import { resolve, sep } from "node:path";
import { loadConfigOrExit, apiGet, apiPost } from "./api.js";
import { resolveAndWalk } from "./sync-projects.js";
import type { Config } from "./config.js";

const MAX_FILE_BYTES = 1_000_000; // mirror the server per-file cap

// Never read or transmit these, no matter what the manifest names. The
// traversal guard in send() keeps reads inside the repo; this denylist keeps
// in-repo secrets (.env files, private keys, credential stores) out of the
// payload even if a compromised/hostile manifest asks for them. Matching is
// on lowercased path segments with trailing dots stripped, so ".ENV" or
// ".env." can't slip through.
const SENSITIVE_DIRS = new Set([".git", ".aws", ".ssh", ".gnupg", ".docker"]);
const SENSITIVE_NAMES = new Set([
  ".npmrc", ".netrc", ".envrc", ".pgpass", ".dockercfg",
  "credentials", "serviceaccount.json", "service-account.json",
  "terraform.tfstate", "terraform.tfstate.backup",
]);
const SENSITIVE_EXTS = [
  ".pem", ".key", ".p12", ".pfx", ".pgp", ".gpg", ".asc",
  ".jks", ".keystore", ".ppk", ".tfstate",
];
// Programming-source extensions. A file such as token.ts or secret.ts is SOURCE
// (grounding it is the whole point of immersion), so the secret-word heuristic
// below must not treat a code file as a credential store just because its name
// contains "token". Secrets live in config / data / dotfiles, not .ts modules.
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".swift", ".kt",
  ".scala", ".sh", ".css", ".scss", ".sass", ".html", ".vue", ".svelte", ".sql",
]);
const SECRET_WORDS = new Set([
  "secret", "secrets", "credential", "credentials", "token", "tokens",
  "password", "passwords", "passwd",
]);
function isSensitivePath(rel: string): boolean {
  const segs = rel.split(/[\\/]/).map((s) => s.toLowerCase().replace(/\.+$/, ""));
  if (segs.some((s) => SENSITIVE_DIRS.has(s))) return true;
  const base = segs[segs.length - 1] ?? "";
  if (SENSITIVE_NAMES.has(base)) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (SENSITIVE_EXTS.some((ext) => base.endsWith(ext))) return true;
  // SSH / signing private keys: id_rsa, id_ed25519, id_ecdsa, id_dsa, and
  // extensionless *_key / deploy_key files.
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  if (ext === "" && (base === "deploy_key" || base.endsWith("_key"))) return true;
  // Secret-word heuristic. Whole-word match (so "tokenizer.ts" is not caught),
  // and never exclude a real source file: github-token.json is a secret store,
  // token.ts is source that immersion is meant to send.
  if (!SOURCE_EXTS.has(ext)) {
    const words = base.split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((w) => SECRET_WORDS.has(w))) return true;
  }
  return false;
}

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
  // Signals for the "nothing happened, here's why" nudge below.
  let reachable = 0;   // repos Replen tracks (manifest returned, not a 404)
  let withPaths = 0;   // tracked repos that have grounded paths to send
  for (const repo of repos) {
    let manifest: Manifest;
    try {
      manifest = await apiPost<Manifest>(cfg, "/api/immersion/manifest", { githubFullName: repo.githubFullName });
    } catch {
      continue; // not tracked on this account (404) / transient — skip quietly
    }
    reachable++;
    if (manifest.tier === "off" || !Array.isArray(manifest.paths) || manifest.paths.length === 0) continue;
    withPaths++;

    // Read exactly the grounded files the server asked for (size-capped).
    // The server sanitizes its manifest paths, but the client must not trust a
    // server-supplied path either: reject `..` traversal and anything that
    // resolves outside this repo so a compromised/hostile manifest can't make
    // `immerse` read files elsewhere on disk. "Your code never leaves except
    // these exact repo files" is only true if we enforce it here too.
    const root = resolve(repo.localPath);
    const files: Array<{ rel: string; content: string }> = [];
    for (const rel of manifest.paths) {
      try {
        if (typeof rel !== "string" || rel.split(/[\\/]/).includes("..")) continue;
        if (isSensitivePath(rel)) continue; // in-repo secret: never read, never send
        const abs = resolve(root, rel);
        if (abs !== root && !abs.startsWith(root + sep)) continue;
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

  if (grounded > 0 || unchanged > 0) {
    const parts: string[] = [];
    if (grounded > 0) parts.push(`grounded ${grounded} repo(s) — ${totalChunks} chunk(s) from ${totalFiles} file(s)`);
    if (unchanged > 0) parts.push(`${unchanged} unchanged`);
    console.log(`\nImmersion: ${parts.join(", ")}.`);
    return;
  }

  // Nothing was grounded — say WHY rather than a silent no-op, and point the
  // user at the step they're missing.
  if (reachable === 0) {
    // Local repos exist, but none are registered with Replen.
    console.log("\nImmersion: none of your local repos are registered with Replen yet — nothing to ground.");
    console.log("Register them with `npx replen` (or `npx replen sync-projects`), then run `/replen-onboard` in Claude Code to ground them. After that, `npx replen immerse` will have something to send.");
  } else if (withPaths === 0) {
    // Tracked, but not onboarded — no grounded capabilities (no file paths) yet.
    console.log("\nImmersion is on, but none of your repos are onboarded yet, so there's nothing to send.");
    console.log("Run `/replen-onboard` in Claude Code first (it's also offered automatically at the start of a session) — it reads each repo and records which files implement each capability. Then re-run `npx replen immerse`.");
  } else {
    // Onboarded with paths, but the files weren't readable / produced nothing.
    console.log("\nImmersion: nothing to update (no readable grounded files changed).");
  }
}
