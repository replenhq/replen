// Multi-repo products. A product usually spans several repos — acme-web,
// acme-cv, acme-api, acme-infra… — but a developer lives in one of them
// (the frontend). Replen scopes matches to the repo you're in, so a CV library
// only surfaces in acme-cv, which you never open. The fix: group a product's
// repos under a shared productKey and match against the UNION of the product's
// capabilities, attributing each match to the repo it's actually for.
//
// v1 grouping is automatic, by owner + a shared name stem (acme-web /
// acme-cv → "acme"). It's deliberately conservative (exact stem match after
// stripping one common suffix); ambiguous cases (cute / acme-clinic) are left
// for an explicit override. Users can set productKey by hand on /projects.

// Common repo-role suffixes stripped to find the product stem.
const ROLE_SUFFIXES = [
  "web", "webapp", "www", "site", "frontend", "front", "ui", "client", "app",
  "api", "backend", "back", "server", "service", "services", "worker", "workers",
  "cv", "ml", "ai", "engine", "core", "lib", "sdk", "cli", "infra", "infrastructure",
  "edge", "edge-agent", "agent", "agents", "daemon", "cron", "jobs", "job",
  "db", "database", "data", "admin", "dashboard", "mobile", "ios", "android",
  "desktop", "docs", "website", "landing", "marketing", "intel-engine",
  "parser-workers", "parser", "phase2", "phase1", "v2", "v1", "next", "legacy",
];

// owner + name, lowercased.
function parse(fullName: string): { owner: string; name: string } | null {
  const m = fullName.trim().toLowerCase().match(/^([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

/** Strip ONE trailing role suffix (hyphen- or underscore-separated). */
function stem(name: string): string {
  for (const suf of ROLE_SUFFIXES.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`[-_]${suf.replace(/[-]/g, "[-_]")}$`);
    if (re.test(name)) return name.replace(re, "");
  }
  return name;
}

/**
 * Derive a product key for a repo: "owner/stem". Repos that share a key are one
 * product. Returns null for an unparseable full name (caller falls back to the
 * repo's own slug, i.e. a product of one).
 */
export function deriveProductKey(githubFullName: string | null | undefined): string | null {
  if (!githubFullName) return null;
  const p = parse(githubFullName);
  if (!p) return null;
  return `${p.owner}/${stem(p.name)}`;
}
