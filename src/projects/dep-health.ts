// Dep-health probe (Initiative #2). For each project dependency, resolves
// the upstream GitHub repo via the ecosystem's registry (npm, PyPI,
// crates.io, pkg.go.dev) and fetches GitHub activity signals (last push,
// archived flag, star count). Used by the prune-suggester to decide
// which deps are stale enough to recommend dropping or replacing.
//
// Cached in project_profiles.dep_health_json with a 7-day TTL because
// deps don't go stale on a daily granularity and the registry/GH API
// quotas are real.

import { readRunOrEnv } from "../analyzer/run-context";
import type { ProjectDep } from "./manifest-parser";

export type UpstreamHealth = {
  ecosystem: ProjectDep["ecosystem"];
  depName: string;
  // Resolved GH repo "owner/name". null when the registry didn't return a
  // GH URL (some npm packages, in-house Python wheels, etc.).
  githubFullName: string | null;
  // ISO date of the upstream's last push. null when GH lookup failed or
  // repo isn't on GH.
  lastPushIso: string | null;
  archived: boolean;
  stars: number | null;
  // Days since lastPushIso. Convenient for the LLM prompt.
  daysSinceLastPush: number | null;
  // Verdict bucket. Drives prune-suggester triage.
  verdict: "fresh" | "stale" | "dead" | "archived" | "unresolved";
  // Free-form reason for the verdict (for UI + log lines).
  verdictReason: string;
};

// Thresholds. Tunable via env so we can experiment without redeploying.
const STALE_DAYS = parseInt(process.env.PRUNE_STALE_DAYS ?? "270", 10);  // ~9 months
const DEAD_DAYS = parseInt(process.env.PRUNE_DEAD_DAYS ?? "540", 10);     // ~18 months

// HTTP timeout per registry / GH call. Total per dep is at most 2 * this
// (registry + gh). Keep tight so a slow registry doesn't stall the run.
const HTTP_TIMEOUT_MS = 6000;

// Per-run concurrency. Higher = faster but more GH rate-limit pressure.
// 5 is a safe default — GH allows 5000/hr with a token; at this rate
// we'd burn 5000 only after a sustained 16+ minutes of constant probing.
export const PROBE_CONCURRENCY = 5;

export async function probeDepHealth(dep: ProjectDep): Promise<UpstreamHealth> {
  // Step 1: registry → GH owner/repo
  const fullName = await resolveGithub(dep);
  if (!fullName) {
    return unresolved(dep, "no GitHub URL on the package registry");
  }
  // Step 2: GH → last push + archived + stars
  const ghHealth = await fetchGhActivity(fullName);
  if (!ghHealth) {
    return unresolved(dep, `GitHub lookup failed for ${fullName}`);
  }
  if (ghHealth.archived) {
    return finalise(dep, fullName, ghHealth, "archived", "upstream repo is archived");
  }
  if (!ghHealth.lastPushIso) {
    return finalise(dep, fullName, ghHealth, "unresolved", "no last-push timestamp available");
  }
  const daysSince = Math.floor((Date.now() - new Date(ghHealth.lastPushIso).getTime()) / (1000 * 60 * 60 * 24));
  if (daysSince >= DEAD_DAYS) {
    return finalise(dep, fullName, ghHealth, "dead", `no push in ${daysSince} days`);
  }
  if (daysSince >= STALE_DAYS) {
    return finalise(dep, fullName, ghHealth, "stale", `no push in ${daysSince} days`);
  }
  return finalise(dep, fullName, ghHealth, "fresh", `last push ${daysSince}d ago`);
}

function unresolved(dep: ProjectDep, reason: string): UpstreamHealth {
  return {
    ecosystem: dep.ecosystem,
    depName: dep.name,
    githubFullName: null,
    lastPushIso: null,
    archived: false,
    stars: null,
    daysSinceLastPush: null,
    verdict: "unresolved",
    verdictReason: reason,
  };
}

function finalise(
  dep: ProjectDep,
  fullName: string,
  gh: { lastPushIso: string | null; archived: boolean; stars: number | null },
  verdict: UpstreamHealth["verdict"],
  reason: string,
): UpstreamHealth {
  return {
    ecosystem: dep.ecosystem,
    depName: dep.name,
    githubFullName: fullName,
    lastPushIso: gh.lastPushIso,
    archived: gh.archived,
    stars: gh.stars,
    daysSinceLastPush: gh.lastPushIso
      ? Math.floor((Date.now() - new Date(gh.lastPushIso).getTime()) / (1000 * 60 * 60 * 24))
      : null,
    verdict,
    verdictReason: reason,
  };
}

// Registry lookup. Each ecosystem exposes a JSON endpoint that includes
// the project's homepage / repository URL. We extract the GH owner/repo
// from whatever URL the registry serves. Returns null when no GH URL is
// found (some packages live on GitLab, BitBucket, or sourcehut).
async function resolveGithub(dep: ProjectDep): Promise<string | null> {
  switch (dep.ecosystem) {
    case "npm":
      return resolveNpm(dep.name);
    case "python":
      return resolvePyPI(dep.name);
    case "cargo":
      return resolveCratesIo(dep.name);
    case "go":
      return resolveGoMod(dep.name);
  }
}

async function resolveNpm(pkg: string): Promise<string | null> {
  // Use the /latest shortcut rather than the full package endpoint. The
  // full one returns the entire version history for packages like
  // drizzle-orm or react (many MB), which busts our 6s parse budget. The
  // /latest endpoint is tiny and includes the `repository` field for
  // any package that publishes it.
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  const json = await fetchJson<{ repository?: string | { url?: string } }>(url);
  if (!json) return null;
  const repoField = json.repository;
  const raw = typeof repoField === "string" ? repoField : repoField?.url;
  return extractGithubFullName(raw);
}

async function resolvePyPI(pkg: string): Promise<string | null> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
  const json = await fetchJson<{ info?: { home_page?: string; project_urls?: Record<string, string> } }>(url);
  if (!json?.info) return null;
  // Try project_urls first ("Source", "Code", "Repository", "Homepage"), then home_page.
  const urls = json.info.project_urls ?? {};
  for (const key of ["Source", "Source Code", "Code", "Repository", "GitHub", "Homepage", "Home"]) {
    const candidate = urls[key];
    const full = extractGithubFullName(candidate);
    if (full) return full;
  }
  return extractGithubFullName(json.info.home_page);
}

async function resolveCratesIo(pkg: string): Promise<string | null> {
  const url = `https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}`;
  const json = await fetchJson<{ crate?: { repository?: string; homepage?: string } }>(url);
  if (!json?.crate) return null;
  return extractGithubFullName(json.crate.repository) ?? extractGithubFullName(json.crate.homepage);
}

async function resolveGoMod(modulePath: string): Promise<string | null> {
  // go.mod modules ARE GitHub paths most of the time (github.com/foo/bar).
  // Strip the github.com/ prefix and treat the rest as owner/name. Sub-
  // module paths (github.com/foo/bar/v2 or .../pkg/sub) collapse to the
  // root repo for activity purposes.
  if (modulePath.startsWith("github.com/")) {
    const parts = modulePath.split("/");
    if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  }
  // Non-GH module paths (golang.org/x/foo, etc.) we can't easily resolve
  // to a GH repo without consulting pkg.go.dev's HTML. Defer.
  return null;
}

// Extract "owner/name" from a string that might be a URL, an SCM URI,
// or a shorthand like "github:foo/bar". Returns null if the input
// doesn't reference github.com.
function extractGithubFullName(input: string | null | undefined): string | null {
  if (!input) return null;
  // Normalise the common SCM URL variants to plain https:
  //   git+https://github.com/foo/bar.git → https://github.com/foo/bar.git
  //   git://github.com/foo/bar.git       → https://github.com/foo/bar.git
  //   ssh://git@github.com:foo/bar.git   → https://github.com/foo/bar.git
  //   git@github.com:foo/bar.git         → https://github.com/foo/bar.git
  //   github:foo/bar                     → matched directly by the regex
  // The previous version had a bug: `git+` was being REPLACED with `https://`
  // even when followed by an existing `https://`, producing `https://https://`.
  let s = input.trim();
  s = s.replace(/^git\+/, "");                      // strip git+ prefix only
  s = s.replace(/^git:\/\//, "https://");           // bare git protocol
  s = s.replace(/^ssh:\/\/git@/, "https://");       // ssh form
  s = s.replace(/^git@/, "https://");               // shorthand SSH (git@github.com:owner/repo)
  const m = s.match(/(?:github\.com[:/]|github:)([\w.-]+)\/([\w.-]+)/i);
  if (!m) return null;
  const owner = m[1];
  const name = m[2].replace(/\.git$/, "");
  return `${owner}/${name}`;
}

async function fetchGhActivity(fullName: string): Promise<{ lastPushIso: string | null; archived: boolean; stars: number | null } | null> {
  const token = readRunOrEnv("githubToken", "GITHUB_TOKEN");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "replen/0.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const json = await fetchJson<{ pushed_at?: string; archived?: boolean; stargazers_count?: number }>(
    `https://api.github.com/repos/${fullName}`,
    headers,
  );
  if (!json) return null;
  return {
    lastPushIso: typeof json.pushed_at === "string" ? json.pushed_at : null,
    archived: !!json.archived,
    stars: typeof json.stargazers_count === "number" ? json.stargazers_count : null,
  };
}

// Minimal fetch wrapper with timeout. Returns null on any failure so
// callers can branch without try/catch noise.
async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { ...headers, accept: headers.Accept ?? "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Bounded-concurrency mapper. Runs `fn` over `items` with at most
// `concurrency` in flight at any time. Order of the output matches the
// input.
export async function mapWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I) => Promise<O>,
): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

// Persisted cache shape: keyed by `<ecosystem>:<dep_name>` so we can do
// per-dep TTL invalidation if needed later. For now the whole blob is
// refreshed together every 7 days.
export type DepHealthCache = {
  generatedAt: string; // ISO
  entries: Record<string, UpstreamHealth>;
};

export function cacheKey(ecosystem: ProjectDep["ecosystem"], name: string): string {
  return `${ecosystem}:${name.toLowerCase()}`;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export function needsHealthRefresh(args: {
  depHealthJson: string | null;
  depHealthGeneratedAt: Date | null;
}): { regen: boolean; reason: string } {
  if (!args.depHealthJson) return { regen: true, reason: "no-cache" };
  if (!args.depHealthGeneratedAt) return { regen: true, reason: "no-timestamp" };
  const age = Date.now() - args.depHealthGeneratedAt.getTime();
  if (age > CACHE_TTL_MS) return { regen: true, reason: "stale-7d" };
  return { regen: false, reason: "fresh" };
}
