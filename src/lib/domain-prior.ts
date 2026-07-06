// Soft subject-area (domain) prior — a bounded, deterministic RANK penalty for
// facet-led candidates that sit far OUTSIDE the project's domain neighbourhood
// (low cosine to the project centroid). This is the cross-domain collision shape:
// a candidate matches one capability facet's *words* but isn't in the project's
// subject area at all.
//
// Distilled from the offline collision experiment (branch experiment/learned-
// reranker), where "subject-area fit" (centroid cosine) was by far the strongest
// dud signal, and where a HARD delete-filter proved unsafe at current label
// volume (no threshold removed duds without also hiding keepers). This soft form
// avoids that failure mode:
//   - it adjusts the sort RANK only — never the displayed cosine, never a hard cut;
//   - it keys on LOW domain-fit, so it sinks off-domain collisions while leaving
//     in-domain matches (keepers cluster high) untouched;
//   - it is bounded (≤ weight·floor) so it can't single-handedly evict a strong match;
//   - it applies ONLY to facet-led candidates (the collision-prone path); centroid-
//     led/whole-project matches and dep matches are unaffected.
//
// OFF by default: weight 0 ⇒ returns 0 ⇒ identical behaviour to today.

export function domainPriorPenalty(centroidCos: number | null, weight: number, floor: number): number {
  if (weight <= 0 || centroidCos === null || !Number.isFinite(centroidCos)) return 0;
  const deficit = Math.max(0, floor - centroidCos); // how far below the domain floor it sits
  return weight * deficit;                           // bounded by weight·floor (centroidCos ≥ 0)
}
