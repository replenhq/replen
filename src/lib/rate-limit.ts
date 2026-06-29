// Lightweight in-memory sliding-window rate limiter for the token-authed write
// routes. Replen runs as a single instance, so an in-memory window is enough to
// stop a runaway loop (the threat is shared-table bloat / CPU burn, not billing
// or cross-instance fairness). It resets on restart, which is fine for abuse
// prevention. Set generously: real use never approaches the ceiling, so a
// legitimate session is never affected.
//
// DB-backed counters (e.g. /api/ingest's candidate-count window) remain the
// right tool where the bound must survive restarts; this is for cheap,
// generous "don't let a token mint unbounded rows" guards.

const buckets = new Map<string, number[]>();
const MAX_KEYS = 50_000; // hard cap so inactive keys can't grow memory unbounded

/**
 * Returns true if the action is ALLOWED (under the limit) and records it; false
 * if the limit is exceeded. `key` should scope the budget (e.g. `writes:<userId>`).
 */
export function allowAction(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const cutoff = now - windowMs;
  const recent = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  // Opportunistic eviction if the map grows too large (a flood of distinct keys).
  if (buckets.size > MAX_KEYS) {
    for (const [k, ts] of buckets) {
      const live = ts.filter((t) => t > cutoff);
      if (live.length === 0) buckets.delete(k); else buckets.set(k, live);
      if (buckets.size <= MAX_KEYS) break;
    }
  }
  return true;
}

// Generous default for the token-authed write routes: a shared hourly budget
// well above any real triage session (which records a handful to dozens).
export const WRITE_LIMIT = Math.max(1, parseInt(process.env.REPLEN_WRITE_RATE_LIMIT ?? "600", 10) || 600);
export const WRITE_WINDOW_MS = 60 * 60 * 1000;
