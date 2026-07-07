// Zero-touch cwd-repo auto-registration, fired from MCP server startup.
//
// The gap this closes: repo auto-registration used to run ONLY from the Claude
// Code SessionStart hook (cli/src/auto-register.ts). On Codex / Cursor / Gemini
// — none of which run that hook — a brand-new repo stayed invisible to Replen
// until the user ran `npx replen sync-projects` by hand. The MCP server, by
// contrast, is spawned by EVERY host, so registering the cwd repo here makes
// new-repo self-registration host-agnostic.
//
// Identity only: registers owner/name (+ the local checkout path) via the same
// idempotent /api/projects/bulk endpoint the CC hook and manual sync use. No
// code is read, no LLM is called, no tags are derived — the CC hook / manual
// sync enrich manifest tags later, and capability grounding is the agent's job
// on first visit. Silent + bounded: this runs on the session-open path, so it
// must never throw into the transport, prompt, or stall; every failure defers
// registration to a future spawn.
//
// Shared cache: reads/writes the same ~/.replen/known-repos.json the CLI hook
// uses, so the MCP and the CC hook never double-POST the same repo (whichever
// runs first records it; the other sees it as known and skips).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ApiConfig } from "./api.js";

const KNOWN_FILE = join(homedir(), ".replen", "known-repos.json");
// Bounded POST: the server upsert must never stall session open. On timeout or
// error we simply don't cache the repo, so a future spawn retries.
const POST_TIMEOUT_MS = 4000;

type KnownRepos = { repos: string[]; lastFullScanAt: string | null };

/**
 * Fire-and-forget wrapper: registers the spawn repo's identity in the
 * background, mirroring refreshAtlasVaultInBackground. Never rejects; logs only
 * to stderr (stdout is the JSON-RPC transport channel).
 */
export function autoRegisterCwdRepoInBackground(cfg: ApiConfig): void {
  void autoRegisterCwdRepo(cfg).catch((e) => {
    console.error(`[replen-mcp] repo auto-register skipped: ${e instanceof Error ? e.message : e}`);
  });
}

async function autoRegisterCwdRepo(cfg: ApiConfig): Promise<void> {
  // No GitHub remote detected → nothing to register. This is also the throwaway-
  // dir filter: repo-detect only yields a repo when origin is a GitHub URL, so a
  // scratch/tmp/local-only directory never registers.
  const gfn = cfg.defaultRepo;
  if (!gfn) return;

  const known = await readKnownRepos();
  const knownSet = new Set(known.repos.map((r) => r.toLowerCase()));
  // Already registered (by this MCP, the CC hook, or a manual sync — they share
  // this cache) → skip the POST. The server upsert is idempotent anyway; the
  // cache just spares a redundant write on every spawn.
  if (knownSet.has(gfn.toLowerCase())) return;

  const ok = await postProjectBulk(cfg, gfn, cfg.repoToplevel);
  if (ok) await mergeKnownRepo(known, gfn);
}

// Derive a bulk-endpoint-valid slug (SLUG_RE: ^[a-z0-9][a-z0-9_-]{0,79}$) from
// the repo name. The server keys on githubFullName, not slug, so exact parity
// with sync-projects' slug isn't required — any legal slug upserts the same row
// and the CLI can re-slug it later. We just need something valid and stable.
export function deriveSlug(gfn: string): string {
  const name = (gfn.split("/").pop() ?? gfn).toLowerCase();
  const cleaned = name
    .replace(/[^a-z0-9_-]/g, "-")   // only slug-legal chars
    .slice(0, 80)                    // SLUG_RE upper bound
    .replace(/^[^a-z0-9]+/, "")      // must start with alnum
    .replace(/[^a-z0-9]+$/, "");     // trim trailing dashes/underscores for tidiness
  return cleaned.length > 0 ? cleaned : "repo";
}

async function postProjectBulk(cfg: ApiConfig, gfn: string, localPath: string | null): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/api/projects/bulk`, {
      method: "POST",
      headers: { "x-digest-token": cfg.token, "content-type": "application/json" },
      body: JSON.stringify({
        projects: [
          {
            slug: deriveSlug(gfn),
            githubFullName: gfn,
            name: gfn.split("/").pop() ?? gfn,
            // Absolute checkout path — inert unless this is a self-host install
            // with Immersion enabled; mirrors the CLI's bulk payload.
            ...(localPath ? { localPath } : {}),
          },
        ],
      }),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readKnownRepos(): Promise<KnownRepos> {
  try {
    const parsed = JSON.parse(await readFile(KNOWN_FILE, "utf8")) as Partial<KnownRepos>;
    return {
      repos: Array.isArray(parsed.repos)
        ? parsed.repos.filter((r): r is string => typeof r === "string")
        : [],
      lastFullScanAt: typeof parsed.lastFullScanAt === "string" ? parsed.lastFullScanAt : null,
    };
  } catch {
    // Missing or malformed cache — treat as "nothing known yet".
    return { repos: [], lastFullScanAt: null };
  }
}

// Add one repo to the shared cache, PRESERVING lastFullScanAt (owned by the CLI
// full-scan throttle — the MCP never does a full walk, so it must not stamp or
// reset that field). Best-effort: a write failure only costs a redundant
// idempotent POST on the next spawn.
async function mergeKnownRepo(cur: KnownRepos, gfn: string): Promise<void> {
  const set = new Set(cur.repos);
  set.add(gfn);
  const next: KnownRepos = { repos: Array.from(set).sort(), lastFullScanAt: cur.lastFullScanAt };
  try {
    await mkdir(dirname(KNOWN_FILE), { recursive: true, mode: 0o700 });
    await writeFile(KNOWN_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // intentionally ignore — cache write must never disrupt a session
  }
}
