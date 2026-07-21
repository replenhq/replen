// Latest published `replen` CLI version, for the client self-update signal
// (layer 2). The inventory endpoint returns this; the SessionStart hook compares
// it to its own version and, when behind, silently re-pins to latest.
//
// Self-maintaining: reads the npm registry with a long in-memory cache, so we
// never have to hand-bump a constant on each CLI publish. NON-BLOCKING: returns
// the cached (or fallback) value instantly and refreshes in the background, so it
// never adds latency to the session-open critical path. Fail-open to the floor.

// Floor: the version this server shipped with. npm is the source of truth; this
// only applies before the first successful registry read (or if npm is down).
const FALLBACK = "1.6.2";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

let cached = FALLBACK;
let fetchedAt = 0;
let inFlight = false;

/** Instant, non-blocking. Returns the cached latest version and kicks off a
 *  background refresh when stale. Never throws, never awaits a network call. */
export function getLatestCliVersion(): string {
  const now = Date.now();
  if (!inFlight && now - fetchedAt > TTL_MS) {
    inFlight = true;
    fetchedAt = now; // stamp up front so a slow/failed fetch doesn't stampede
    fetch("https://registry.npmjs.org/replen/latest", { signal: AbortSignal.timeout(2500) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        const v = (j as { version?: unknown } | null)?.version;
        if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) cached = v;
      })
      .catch(() => { /* keep the last good value / fallback */ })
      .finally(() => { inFlight = false; });
  }
  return cached;
}
