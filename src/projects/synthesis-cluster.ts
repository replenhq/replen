// Match clustering for synthesis (Initiative #3). Pure programmatic
// layer — no LLM here. Takes the matches produced during a single run
// and returns clusters worth synthesising. The synthesizer (LLM) only
// fires on clusters this code identifies.
//
// Three cluster shapes:
//   topic         ≥3 matches sharing meaningful tokens or theme tags
//   cross-project ≥2 matches landing on ≥2 different projects via
//                 shared tokens (the user has multiple projects that
//                 could all benefit from the same finding)
//   approach      ≥3 matches with the same integrationApproach
//                 (signal: lots of "rebuild in-house" or "cherry-pick"
//                 candidates in this run, worth a meta-comment)

import type { schema } from "../db/client";

type Match = typeof schema.matches.$inferSelect;

export type MatchFeature = {
  matchId: number;
  projectSlug: string;
  tokens: Set<string>; // normalised content tokens
  themes: Set<string>; // explicit themes (from prune dep ecosystems, scouted needs, etc.)
  approach: string | null;
};

export type Cluster = {
  kind: "topic" | "cross-project" | "approach";
  matchIds: number[];
  sharedTokens: string[]; // tokens / themes that bind the cluster
  primaryProjectSlug: string | null;
  // For approach clusters, which approach value.
  approach?: string;
};

// Tokens that appear in nearly every writeup. Useless as cluster signal.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "their",
  "have", "has", "you", "are", "is", "be", "of", "to", "in", "a", "an", "or",
  "but", "by", "as", "at", "on", "it", "its", "if", "not", "no", "yes",
  "via", "use", "uses", "using", "used", "would", "could", "can", "should",
  "what", "which", "who", "how", "when", "where", "why",
  "project", "repo", "library", "tool", "package", "framework",
  "github", "open", "source", "code", "based", "build", "built",
  "support", "supports", "supported", "feature", "features", "function",
  "more", "less", "most", "least", "very", "really", "quite", "pretty",
  "needs", "need", "needed", "wants", "want", "wanted", "fits", "fit",
  "match", "matches", "matched", "active", "current", "currently",
]);

const MIN_TOKEN_LEN = 4;
const MAX_TOKEN_LEN = 24;

// Pull meaningful tokens out of a free-text writeup. Lowercased, stop-
// worded, length-bounded. Returns a Set so callers can do cheap
// intersections.
function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    const t = raw.trim();
    if (t.length < MIN_TOKEN_LEN || t.length > MAX_TOKEN_LEN) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue; // pure numbers aren't useful
    out.add(t);
  }
  return out;
}

// Build a MatchFeature per match. Pulled out so tests can hit it
// directly without DB round-trips.
export function buildFeatures(
  matches: Pick<Match, "id" | "summary" | "whyUseful" | "suggestedUse" | "integrationApproach" | "projectId" | "prunedDepEcosystem" | "matchedOutcome">[],
  projectSlugById: Map<number, string>,
): MatchFeature[] {
  const features: MatchFeature[] = [];
  for (const m of matches) {
    const text = [m.summary ?? "", m.whyUseful ?? "", m.suggestedUse ?? ""].join(" ");
    const tokens = tokenise(text);
    const themes = new Set<string>();
    if (m.prunedDepEcosystem) themes.add(`ecosystem:${m.prunedDepEcosystem}`);
    if (m.matchedOutcome) {
      // The matched outcome is a verbatim user need; pull tokens from
      // it too so prune+scouted matches can cluster on shared intent.
      for (const t of tokenise(m.matchedOutcome)) themes.add(`need:${t}`);
    }
    features.push({
      matchId: m.id,
      projectSlug: m.projectId ? projectSlugById.get(m.projectId) ?? "_unknown" : "_general",
      tokens,
      themes,
      approach: m.integrationApproach && m.integrationApproach !== "n/a" ? m.integrationApproach : null,
    });
  }
  return features;
}

// Pair-shared-token cluster. For each pair of features that shares ≥
// MIN_SHARED tokens, accumulate into a connected-component. Returns
// clusters of size ≥ MIN_CLUSTER_SIZE.
const MIN_SHARED_TOKENS = 3;
const MIN_TOPIC_CLUSTER_SIZE = 3;
const MIN_CROSS_PROJECT_SIZE = 2; // unique projects, not matches

export function findTopicClusters(features: MatchFeature[]): Cluster[] {
  if (features.length < MIN_TOPIC_CLUSTER_SIZE) return [];
  const n = features.length;
  // Union-find over feature indices, merging any pair that shares
  // ≥ MIN_SHARED_TOKENS tokens (combining tokens + themes).
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = countSharedTokens(features[i], features[j]);
      if (shared >= MIN_SHARED_TOKENS) union(i, j);
    }
  }

  // Group by root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: Cluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < MIN_TOPIC_CLUSTER_SIZE) continue;
    const members = idxs.map((i) => features[i]);
    const shared = intersectAll(members.map((m) => m.tokens));
    const sharedThemes = intersectAll(members.map((m) => m.themes));
    const allShared = [...shared, ...sharedThemes].slice(0, 12);
    if (allShared.length === 0) continue;
    clusters.push({
      kind: "topic",
      matchIds: members.map((m) => m.matchId),
      sharedTokens: allShared,
      primaryProjectSlug: dominantProject(members),
    });
  }
  return clusters;
}

// Cross-project: clusters where the same shared signal hits multiple
// projects. Useful when sandbox-nextapp + drone + acme-web all get the
// same kind of fit suggested. Different threshold (≥2 matches across ≥2
// projects) and different output framing.
export function findCrossProjectClusters(features: MatchFeature[]): Cluster[] {
  // Group features by every individual token so we can detect "token X
  // appears in matches that span multiple projects".
  const byToken = new Map<string, Set<number>>(); // token → indices of features carrying it
  for (let i = 0; i < features.length; i++) {
    for (const t of features[i].tokens) {
      if (!byToken.has(t)) byToken.set(t, new Set());
      byToken.get(t)!.add(i);
    }
    for (const t of features[i].themes) {
      if (!byToken.has(t)) byToken.set(t, new Set());
      byToken.get(t)!.add(i);
    }
  }

  // For each token shared by features from ≥2 different projects,
  // collect the spanning feature set.
  const seenMatchKey = new Set<string>(); // dedup by matchIds sig
  const clusters: Cluster[] = [];
  for (const [token, idxs] of byToken) {
    if (idxs.size < 2) continue;
    const involved = [...idxs].map((i) => features[i]);
    const projects = new Set(involved.map((f) => f.projectSlug).filter((s) => s !== "_general" && s !== "_unknown"));
    if (projects.size < MIN_CROSS_PROJECT_SIZE) continue;

    // Dedup: if we've already emitted a cluster with this exact match
    // set on a different token, skip. Multi-token overlap inflates
    // results otherwise.
    const sigKey = involved.map((f) => f.matchId).sort((a, b) => a - b).join(",");
    if (seenMatchKey.has(sigKey)) continue;
    seenMatchKey.add(sigKey);

    clusters.push({
      kind: "cross-project",
      matchIds: involved.map((f) => f.matchId),
      sharedTokens: [token, ...intersectAll(involved.map((f) => f.tokens))].slice(0, 8),
      primaryProjectSlug: null,
    });
  }
  // Keep only the highest-coverage cross-project finding per project-set
  // so we don't surface 10 variations of the same trio. Sort by
  // (project count desc, match count desc) and take top 3.
  clusters.sort((a, b) => {
    const pa = new Set(a.matchIds.map((id) => features.find((f) => f.matchId === id)?.projectSlug)).size;
    const pb = new Set(b.matchIds.map((id) => features.find((f) => f.matchId === id)?.projectSlug)).size;
    if (pb !== pa) return pb - pa;
    return b.matchIds.length - a.matchIds.length;
  });
  return clusters.slice(0, 3);
}

const MIN_APPROACH_CLUSTER_SIZE = 3;

// Approach clusters fire when multiple matches in the same run share an
// integrationApproach value. "5 cleanroom-rebuilds this week" is itself
// worth flagging.
export function findApproachClusters(features: MatchFeature[]): Cluster[] {
  const byApproach = new Map<string, number[]>();
  for (let i = 0; i < features.length; i++) {
    const a = features[i].approach;
    if (!a) continue;
    if (!byApproach.has(a)) byApproach.set(a, []);
    byApproach.get(a)!.push(i);
  }
  const clusters: Cluster[] = [];
  for (const [approach, idxs] of byApproach) {
    if (idxs.length < MIN_APPROACH_CLUSTER_SIZE) continue;
    const members = idxs.map((i) => features[i]);
    clusters.push({
      kind: "approach",
      matchIds: members.map((m) => m.matchId),
      sharedTokens: [],
      primaryProjectSlug: dominantProject(members),
      approach,
    });
  }
  return clusters;
}

function countSharedTokens(a: MatchFeature, b: MatchFeature): number {
  let n = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) n++;
  for (const t of a.themes) if (b.themes.has(t)) n++;
  return n;
}

function intersectAll(sets: Set<string>[]): string[] {
  if (sets.length === 0) return [];
  const first = sets[0];
  const out: string[] = [];
  for (const t of first) {
    let everywhere = true;
    for (let i = 1; i < sets.length; i++) {
      if (!sets[i].has(t)) { everywhere = false; break; }
    }
    if (everywhere) out.push(t);
  }
  return out;
}

function dominantProject(members: MatchFeature[]): string | null {
  const counts = new Map<string, number>();
  for (const f of members) {
    if (f.projectSlug === "_general" || f.projectSlug === "_unknown") continue;
    counts.set(f.projectSlug, (counts.get(f.projectSlug) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [slug, c] of counts) {
    if (c > bestCount) { best = slug; bestCount = c; }
  }
  return best;
}

// Per-run cap on synthesised insights. Bounded LLM cost.
export const MAX_INSIGHTS_PER_RUN = parseInt(process.env.SYNTHESIS_MAX_INSIGHTS_PER_RUN ?? "5", 10);

// Top-level entry. Returns clusters ready for synthesis, capped.
export function findClusters(
  matches: Pick<Match, "id" | "summary" | "whyUseful" | "suggestedUse" | "integrationApproach" | "projectId" | "prunedDepEcosystem" | "matchedOutcome">[],
  projectSlugById: Map<number, string>,
): Cluster[] {
  const features = buildFeatures(matches, projectSlugById);
  const topic = findTopicClusters(features);
  const crossProject = findCrossProjectClusters(features);
  const approach = findApproachClusters(features);
  // Order: topic first (richest insight), then cross-project, then approach.
  // Sort topic clusters by size desc so the biggest convergences surface
  // first when the per-run cap binds.
  topic.sort((a, b) => b.matchIds.length - a.matchIds.length);
  approach.sort((a, b) => b.matchIds.length - a.matchIds.length);
  return [...topic, ...crossProject, ...approach].slice(0, MAX_INSIGHTS_PER_RUN);
}
