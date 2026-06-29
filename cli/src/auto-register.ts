// Zero-touch repo auto-registration, run from the SessionStart hook.
//
// The problem this closes: registration used to happen ONLY when the user ran
// `npx replen sync-projects` by hand. A repo they cloned/created and never
// manually synced was invisible to Replen — so it never got matched, and the
// user had to remember a step. This folds discovery into the hook that
// already runs every session, so a repo's *identity* registers itself the
// first time the user opens Claude Code anywhere near it.
//
// Two triggers, both bounded and silent (this is on the session-open critical
// path; it must never prompt, log to the user, slow things down, or throw):
//   1. cwd fast-path — the repo the user just opened. Cheap (a single-repo
//      walk), runs every session, catches the "I just made this repo" case
//      immediately.
//   2. throttled full walk — the whole portfolio, at most once per
//      FULL_SCAN_INTERVAL. Belt-and-suspenders for repos cloned but not yet
//      opened in Claude Code.
//
// Identity only: this registers owner/name (+ manifest-derived tags) via the
// same local-FS `discoverProjects` the manual sync uses. No code is read, no
// LLM is called. Capability/facet profiling is Part 2 (onboard-on-first-visit).

import { execSync } from "node:child_process";
import { discoverProjects, type DiscoveredProject } from "./discover-projects.js";
import { readKnownRepos, mergeKnownRepos } from "./known-repos.js";
import {
  rootsFromClaudeJson,
  rootsFromConfig,
  rootsFromEnv,
  rootsFromHardcoded,
} from "./discover-roots.js";

// How often the full-portfolio filesystem walk may run. The walk is local-FS
// only but still touches every repo under the user's roots, so we don't want
// it on every session — the cwd fast-path covers the common case in between.
const FULL_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// Hard ceiling on the bulk POST. The hook is blocking session open; a slow or
// unreachable server must not stall it. Errors / timeouts just defer
// registration to a future session (the repo stays "unknown" in the cache).
const POST_TIMEOUT_MS = 4000;

type AutoRegisterOptions = {
  token: string;
  base: string;
};

/**
 * Discover repos that aren't yet known to Replen and register their identity.
 * Best-effort and silent: every failure path returns quietly. Designed to be
 * awaited in parallel with the inventory fetch so it adds ~no wall-clock when
 * there's nothing new (the common case: cwd repo already known, no scan due).
 */
export async function autoRegisterNewRepos(opts: AutoRegisterOptions): Promise<void> {
  const known = await readKnownRepos();
  const knownSet = new Set(known.repos.map((r) => r.toLowerCase()));
  const scanDue = isFullScanDue(known.lastFullScanAt);

  // Gather discovered projects, deduped by githubFullName across both triggers.
  const byFullName = new Map<string, DiscoveredProject>();

  // 1. cwd fast-path: walk just the repo the user opened (resolved to its
  //    git toplevel so subdir cwds still work).
  const cwdRoot = repoRootForCwd();
  if (cwdRoot) {
    for (const p of safeDiscover([cwdRoot])) {
      if (p.githubFullName) byFullName.set(p.githubFullName, p);
    }
  }

  // 2. throttled full walk.
  if (scanDue) {
    const roots = await resolveScanRoots();
    if (roots.length > 0) {
      for (const p of safeDiscover(roots)) {
        if (p.githubFullName) byFullName.set(p.githubFullName, p);
      }
    }
  }

  const fresh = Array.from(byFullName.values()).filter(
    (p) => p.githubFullName && !knownSet.has(p.githubFullName.toLowerCase()),
  );

  if (fresh.length === 0) {
    // Nothing new — but if a scan was due, record that it ran so we don't
    // re-walk the filesystem every session.
    if (scanDue) await mergeKnownRepos([], true);
    return;
  }

  const ok = await postProjectsBulk(opts.base, opts.token, fresh);
  if (ok) {
    // Cache the now-registered repos so we don't re-POST them next session.
    await mergeKnownRepos(
      fresh.map((p) => p.githubFullName as string),
      scanDue,
    );
  } else if (scanDue) {
    // POST failed: don't mark these repos known (a later session retries
    // them), but do stamp the scan time so we don't re-walk on every session
    // while the server is unreachable. The cwd fast-path still retries.
    await mergeKnownRepos([], true);
  }
}

function isFullScanDue(lastFullScanAt: string | null): boolean {
  if (!lastFullScanAt) return true;
  const t = Date.parse(lastFullScanAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > FULL_SCAN_INTERVAL_MS;
}

// Resolve the cwd to its git repo root so a subdir cwd still discovers the
// repo. Returns null when not in a git repo.
function repoRootForCwd(): string | null {
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    return top || null;
  } catch {
    return null;
  }
}

// Non-interactive root resolution for the full walk. Mirrors sync-projects'
// inference order but NEVER prompts (the hook has no TTY contract) — config
// and env first, then the high-signal Claude-tracked dirs and conventional
// layout. discoverProjects dedups by path + githubFullName, so the union is
// safe even when roots overlap.
async function resolveScanRoots(): Promise<string[]> {
  const fromConfig = await rootsFromConfig();
  return Array.from(
    new Set<string>([
      ...fromConfig,
      ...rootsFromEnv(),
      ...rootsFromClaudeJson(),
      ...rootsFromHardcoded(),
    ]),
  );
}

// discoverProjects shells out to git per repo; guard the whole walk so a
// transient FS/git error can't bubble out of the hook.
function safeDiscover(roots: string[]): DiscoveredProject[] {
  try {
    return discoverProjects(roots).projects;
  } catch {
    return [];
  }
}

// Silent, bounded POST to the same bulk-upsert endpoint the manual sync uses.
// Returns whether the registration succeeded.
async function postProjectsBulk(
  base: string,
  token: string,
  projects: DiscoveredProject[],
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/projects/bulk`, {
      method: "POST",
      headers: {
        "x-digest-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projects: projects.map((p) => ({
          slug: p.slug,
          githubFullName: p.githubFullName,
          name: p.name,
          tags: p.tags,
          primaryLanguage: p.primaryLanguage ?? undefined,
          // Absolute local checkout path — see sync-projects.ts. Inert unless
          // the server is a self-host install with Immersion enabled.
          localPath: p.localPath,
        })),
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
