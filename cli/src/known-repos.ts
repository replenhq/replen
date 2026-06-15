// Local cache of repos Replen has already seen, plus the timestamp of the
// last full-portfolio scan. Lives next to the auth config in ~/.replen/.
//
// Purpose: the SessionStart hook (auto-register.ts) needs to answer "is this
// repo new?" without POSTing the user's whole portfolio to the server on
// every single session. We cache the set of githubFullNames we've registered
// and only send the diff. The server upsert is idempotent, so a stale cache
// is harmless (worst case: a redundant POST); the cache is a latency
// optimisation, not a source of truth.
//
// Identity only — this file never stores code, paths, or capabilities, just
// the owner/name strings already public on GitHub.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const KNOWN_FILE = join(homedir(), ".replen", "known-repos.json");

export type KnownRepos = {
  /** Sorted, unique list of githubFullName ("owner/name") already registered. */
  repos: string[];
  /** ISO timestamp of the last full-portfolio filesystem walk, or null. */
  lastFullScanAt: string | null;
};

const EMPTY: KnownRepos = { repos: [], lastFullScanAt: null };

export async function readKnownRepos(): Promise<KnownRepos> {
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
    return { ...EMPTY };
  }
}

/**
 * Merge newly-registered repos into the cache. When `didFullScan` is true,
 * also stamp `lastFullScanAt` so the throttled full walk doesn't re-run for
 * the configured interval. Best-effort: a write failure is swallowed (the
 * cache only ever costs a redundant idempotent POST next session).
 */
export async function mergeKnownRepos(newRepos: string[], didFullScan: boolean): Promise<void> {
  const cur = await readKnownRepos();
  const set = new Set(cur.repos);
  for (const r of newRepos) set.add(r);
  const next: KnownRepos = {
    repos: Array.from(set).sort(),
    lastFullScanAt: didFullScan ? new Date().toISOString() : cur.lastFullScanAt,
  };
  try {
    await mkdir(dirname(KNOWN_FILE), { recursive: true, mode: 0o700 });
    await writeFile(KNOWN_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // intentionally ignore — cache write must never disrupt a session
  }
}
