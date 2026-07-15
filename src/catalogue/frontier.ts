// Frontier prior — the age-based ranking weight, extracted as a PURE module so:
//   1. the catalogue reader (its internal per-facet-cap sort) and the inventory
//      route (the merged final ranker) apply the IDENTICAL curve — one source of
//      truth, no drift between the two candidate paths; and
//   2. it can be unit-tested in isolation, without importing the DB-bound reader
//      (db/client.ts runs top-level PRAGMAs on import).
//
// Design: repo age is a PROXY for "do the frontier models already know this?" —
// a newer repo is likelier to be something the in-session agent won't surface on
// its own, which is the discovery value. This is a WEIGHT, never a gate: an old
// repo is never dropped, it just needs stronger relevance to outrank a fresh one
// (the boost is added ABOVE the relevance floor, so a boosted repo is always a
// real match, just younger). Age is only the COLD-START estimate of novelty;
// triage outcomes correct it downstream (Phase 2 novelty override keeps a still-
// undiscovered old repo — e.g. Scrapling past 24mo — weighted up despite age).

// Decay window: a repo older than this gets no tilt. Default 24 months.
export const FRONTIER_MONTHS = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_FRONTIER_MONTHS ?? "24", 10) || 24);
// Max additive boost for a brand-new repo. The key dial triage will calibrate:
// big enough that a fresh, relevant repo beats an established near-match, small
// enough that a much stronger established match still wins.
export const FRONTIER_MAX_BOOST = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_FRONTIER_BOOST ?? "0.12"));

/** Additive ranking boost for a repo of the given age in DAYS. Smooth linear
 *  decay from FRONTIER_MAX_BOOST (age 0) to 0 at FRONTIER_MONTHS. Unknown age
 *  (null/negative) or age past the window → 0: no tilt, never a gate. */
export function frontierBoost(ageDays: number | null): number {
  if (ageDays == null || ageDays < 0) return 0;
  const windowDays = FRONTIER_MONTHS * 30;
  if (ageDays >= windowDays) return 0;
  return FRONTIER_MAX_BOOST * (1 - ageDays / windowDays);
}
