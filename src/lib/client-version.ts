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

// What each @replen/mcp MINOR release actually added, keyed by "<major>.<minor>".
// The nudge composes its "what's new" line from this — so it names the REAL
// highlights of the versions the user is missing, never a hardcoded/stale list.
//
// Source of truth is mcp-highlights.json, written by scripts/release-mcp.mjs at
// release time (highlight capture is a required step of bumping a minor). If an
// entry is missing the nudge degrades gracefully to naming just the version
// (honest, never wrong). Patch releases get no entry (they never trigger a nudge).
import mcpHighlightsRaw from "./mcp-highlights.json";

const MCP_MINOR_HIGHLIGHTS: Record<string, string> = mcpHighlightsRaw as Record<string, string>;

/** Highlights for every minor strictly newer than `cur` up to and including `latest`. */
function missingHighlights(cv: number[], lv: number[]): string[] {
  const out: string[] = [];
  if (cv[0] !== lv[0]) {
    // Cross-major gap: don't try to enumerate every minor; just take the latest's note.
    const top = MCP_MINOR_HIGHLIGHTS[`${lv[0]}.${lv[1]}`];
    return top ? [top] : [];
  }
  for (let minor = (cv[1] ?? 0) + 1; minor <= (lv[1] ?? 0); minor++) {
    const note = MCP_MINOR_HIGHLIGHTS[`${lv[0]}.${minor}`];
    if (note) out.push(note);
  }
  return out;
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
  // falsely tripped this on every up-to-date session. So: no version → say nothing;
  // only the MCP tool path (which sends its version) can trigger a real nudge.
  if (!cur) return "";
  // Patch-tolerant: only nudge on a MINOR or MAJOR gap. A patch-level gap (e.g.
  // 1.0.35 -> 1.0.38) is auto-picked-up by npx and ships no new tools, so nudging
  // on it is pure noise. Real new features land in minor bumps.
  const cv = cur.split(".").map((n) => parseInt(n, 10) || 0);
  const lv = latest.split(".").map((n) => parseInt(n, 10) || 0);
  if (cv[0] > lv[0] || (cv[0] === lv[0] && (cv[1] ?? 0) >= (lv[1] ?? 0))) return ""; // same-or-newer minor → silent

  // Build the "what's new" clause from the versions the user is actually missing.
  const notes = missingHighlights(cv, lv);
  const whatsNew = notes.length ? ` — it brings ${joinList(notes)}` : "";
  // IMPORTANT: the MCP launches from an EXACT version pinned in the host config
  // (mcp-setup pins it). `npx @replen/mcp@latest` alone does NOT change that pin,
  // so the session keeps spawning the old build and the nudge never clears — the
  // "I keep seeing this even after updating" bug. `npx replen` re-runs setup,
  // which re-pins the MCP to the latest build AND refreshes the skill. That's the
  // instruction that actually resolves it.
  return `_A newer Replen is available (v${lv[0]}.${lv[1]})${whatsNew}. Run \`npx replen\` to update — it re-pins the MCP to the latest build and refreshes the skill — then restart your session._`;
}

/** "a", "a and b", "a, b and c" */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Append a nudge to a footnote, or surface it alone when there's no footnote. */
export function withUpgradeNudge(displayText: string | null, nudge: string): string | null {
  if (!nudge) return displayText;
  return displayText ? `${displayText}\n\n${nudge}` : nudge;
}
