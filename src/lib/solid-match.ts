// Honest-count "solid" bar — the validated matching-precision logic, shared by
// the surfacing route AND the offline replay (src/cli/exp-matching-replay.ts) so
// the production behaviour is provably identical to what the replay gates.
//
// Validated on 210 hand-triages (experiment/matching-precision): two-tier domain-fit
// bar + dep-maintenance/feed-source bypass + covered detector. It governs only the
// HEADLINE COUNT (how many we call "solid") — it NEVER filters the returned
// candidates, so a mis-gated keeper stays fully triageable in the tail / explore slot.
// Recall result: 0/23 keepers deleted; the 6 demoted are genuine low-domain-fit laterals.

export type SolidSignals = {
  centroidCos: number | null;   // candidate ↔ project centroid
  anchorCos: number | null;     // candidate ↔ project domain-anchor (subject-area terms)
  matchedFacet: string | null;  // the capability it led on (null = whole-project/tag hit)
  repoShape: string | null;     // library | framework | app | template | aggregator | null
  source: string | null;        // fetcher source (feed-lens prefixes bypass)
  depMatch: boolean;            // a release of a dep you already run (Pattern A)
  covered: boolean;             // matched capability already filled (existing isCovered)
  coveredByDeps: boolean;       // own-lib or predecessor-of-an-owned dep (covered detector)
};

export type SolidThresholds = { hiCentroid: number; hiAnchor: number; modCentroid: number; modAnchor: number };
export const DEFAULT_SOLID: SolidThresholds = { hiCentroid: 0.52, hiAnchor: 0.46, modCentroid: 0.46, modAnchor: 0.40 };

// Feed-lens / dep-maintenance sources: a release/advisory of something you use is a
// near-certain keeper and is low/null domain-fit by nature — bypass the domain gate.
const FEED = /^(health-watch|security-watch|stack-watch|spec-watch|release)/i;
const bypass = (s: SolidSignals) => s.depMatch || FEED.test(s.source ?? "");
const postureOk = (s: SolidSignals) => s.repoShape == null || s.repoShape === "library";

export function isSolid(s: SolidSignals, t: SolidThresholds = DEFAULT_SOLID): boolean {
  if (bypass(s)) return true;                                     // dep maintenance / feed lens
  if (s.covered || s.coveredByDeps) return false;                 // already have it
  if (s.centroidCos == null && s.anchorCos == null) return true;  // abstain — don't silence an un-backfilled candidate
  // TWO-TIER. HIGH domain-fit ⇒ solid unconditionally (rescues 0.52–0.64-centroid ports).
  // MODERATE fit must ALSO be a clean facet-led library hit (excludes moderate-fit wrong-posture
  // / fuzzy skips). Posture is otherwise a soft rank signal, never a headline gate.
  const hi = (s.centroidCos != null && s.centroidCos >= t.hiCentroid) || (s.anchorCos != null && s.anchorCos >= t.hiAnchor);
  if (hi) return true;
  const mod = (s.centroidCos != null && s.centroidCos >= t.modCentroid) || (s.anchorCos != null && s.anchorCos >= t.modAnchor);
  return mod && s.matchedFacet != null && postureOk(s);
}

// Reviewed predecessor → successor seed (operational, k-anon-clean: public lib facts,
// never user vocabulary). Drop a predecessor ONLY when the user owns the successor.
export const SUPERSEDED: Record<string, string> = {
  bull: "bullmq", "sqlite-vss": "sqlite-vec", moment: "dayjs", request: "got",
  "node-sass": "sass", "@ffmpeg-installer/ffmpeg": "ffmpeg-static", tslint: "eslint",
  enzyme: "@testing-library/react", "babel-eslint": "@babel/eslint-parser",
};
const normDep = (s: string) => s.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9.-]/g, "");

// Covered detector: the candidate IS a lib you already depend on, OR it's a known
// predecessor of a dep you own. Verified keeper-immune on the 210 (0/23 keepers).
export function coveredByDeps(candidateName: string, ownedDeps: Set<string>): boolean {
  const n = normDep(candidateName);
  if (ownedDeps.has(n)) return true;
  const succ = SUPERSEDED[n];
  return !!succ && ownedDeps.has(normDep(succ));
}

export const normOwnedDep = normDep;
