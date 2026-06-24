// Client freshness nudge. The MCP/CLI run via `npx`, which caches aggressively
// and will happily keep spawning a months-old build even after a new one ships
// (npx reuses the cached version without re-resolving). A user on a stale build
// silently misses new tools (Leaps, Recall, ...). So the server tells them.
//
// The MCP sends its version in `x-replen-client: mcp@<version>`. We compare it
// to the latest published @replen/mcp (npm registry, cached 6h, fail-open) and,
// when the client is behind — or sends no version header at all, which is
// exactly the stale-cache case the old build can't self-detect — we return a
// one-line nudge the footnote appends.

const REGISTRY_URL = "https://registry.npmjs.org/@replen/mcp/latest";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { version: string | null; at: number } | null = null;

/** Latest published @replen/mcp version, cached 6h. null if the registry can't be reached. */
export async function latestMcpVersion(now = Date.now()): Promise<string | null> {
  if (cache && now - cache.at < TTL_MS) return cache.version;
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const json = (await res.json()) as { version?: string };
    cache = { version: typeof json.version === "string" ? json.version : null, at: now };
  } catch {
    // Fail-open: keep any prior value, refresh the timestamp so we don't hammer
    // the registry on every request when it's down.
    cache = { version: cache?.version ?? null, at: now };
  }
  return cache.version;
}

/** a < b for plain x.y.z versions. Non-numeric / missing parts treated as 0. */
export function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/**
 * One-line markdown nudge when the calling client is stale, else "".
 * @param clientHeader value of `x-replen-client` (e.g. "mcp@1.0.11"), or null.
 */
export async function clientUpgradeNudge(clientHeader: string | null): Promise<string> {
  const latest = await latestMcpVersion();
  if (!latest) return ""; // can't determine a target → say nothing
  const cur = clientHeader?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  // Only nudge when we can SEE the client is genuinely behind. A MISSING version
  // header is no longer treated as stale: the in-session /replen skill fetches the
  // inventory via raw `curl` (x-digest-token only, no x-replen-client), which
  // falsely tripped this on every up-to-date session. The stale-npx-cache case
  // that "no header → nudge" was meant to catch is now handled properly by exact
  // MCP version pinning in `mcp setup`. So: no version → say nothing; only the
  // MCP tool path (which sends its version) can trigger a real, correct nudge.
  if (!cur) return "";
  // Patch-tolerant: only nudge on a MINOR or MAJOR gap. A patch-level gap (e.g.
  // 1.0.35 -> 1.0.38) is auto-picked-up by the `@^1` npx spec and ships no new
  // tools, so nudging on it is pure noise — the "it nags on every message even when
  // I'm current" complaint. Real new features (Leaps, Recall) land in minor bumps.
  const cv = cur.split(".").map((n) => parseInt(n, 10) || 0);
  const lv = latest.split(".").map((n) => parseInt(n, 10) || 0);
  if (cv[0] > lv[0] || (cv[0] === lv[0] && (cv[1] ?? 0) >= (lv[1] ?? 0))) return ""; // same-or-newer minor → silent
  return "_Heads up, a newer Replen is available (this is how you get new features like Leaps and Recall). Run `npx -y @replen/mcp@latest` and restart your session to update — it clears the stale npx cache._";
}

/** Append a nudge to a footnote, or surface it alone when there's no footnote. */
export function withUpgradeNudge(displayText: string | null, nudge: string): string | null {
  if (!nudge) return displayText;
  return displayText ? `${displayText}\n\n${nudge}` : nudge;
}
