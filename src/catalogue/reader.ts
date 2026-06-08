// Phase 5 — catalogue reader. Matches the shared capability catalogue against a
// scoped project, using the SAME faceted scoring as the per-user pool: best of
// (project centroid, project facets) cosine, with the same relevance floor and
// competitor suppression. So the catalogue surfaces a library that fills one of
// the project's capabilities even when the project's own targeted search hasn't
// fetched it yet — without becoming a trending firehose.

import { db, schema } from "../db/client";
import { desc, isNotNull } from "drizzle-orm";
import { cosineSimilarity, parseStoredEmbedding, type FacetEmbedding } from "../lib/embeddings";
import { KEEP_KINDS, RISING_KINDS, type RepoKind } from "./classify";

export type CatalogueMatch = {
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  url: string | null;
  stars: number | null;
  language: string | null;
  license: string | null;
  topics: string[];
  repoShape: string | null;
  cosine: number;
  matchedFacet: string | null;
  matchedRepo: string | null; // sibling repo this is for, when cross-repo (multi-repo products)
  ageDays: number | null;   // repo age; null when unknown
  rising: boolean;          // recent + relevant → "rising in your space"
};

// Language/runtime compatibility. A library is only useful if you can actually
// use it. Platform-locked languages (Java/Android, Swift/iOS, C#/.NET, Dart) are
// hard-incompatible — you can't import an Android job-queue into a Node bot — so
// a repo in one of those, for a project that doesn't use it, is excluded.
// Other cross-language (Python/Rust/Go/C) is a SOFT penalty: you might use it via
// a sidecar or port the idea, but it shouldn't outrank a same-language fit.
const PLATFORM_LOCKED = new Set(["java", "kotlin", "swift", "objective-c", "objective-c++", "dart", "c#", "scala", "groovy"]);
const JS_FAMILY = new Set(["javascript", "typescript", "coffeescript"]);
const CROSS_LANG_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_CROSSLANG_PENALTY ?? "0.06"));

// Returns Infinity (exclude) for hard-incompatible, else a cosine penalty.
function languagePenalty(projectLangs: Set<string>, repoLang: string | null): number {
  if (!repoLang || projectLangs.size === 0) return 0;
  const rl = repoLang.toLowerCase();
  if (projectLangs.has(rl)) return 0;
  if (JS_FAMILY.has(rl) && [...projectLangs].some((l) => JS_FAMILY.has(l))) return 0;
  if (PLATFORM_LOCKED.has(rl)) return Infinity; // can't import it — exclude
  return CROSS_LANG_PENALTY; // sidecar/port-able, but down-rank vs same-language
}

// Recency/trending boost. A recently-CREATED repo that's relevant is the
// "rising gem" signal — the thing you'd catch on a creator's feed before it's
// canonical. It gets a bonus added to its ranking score (not its cosine — the
// relevance floor still applies), so a fresh newcomer ranks alongside/above the
// all-time star leader instead of being buried under it. Linear decay over the
// window. "rising" flags repos young enough to call out as discoveries.
const RECENCY_MONTHS = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_RECENCY_MONTHS ?? "12", 10) || 12);
const RECENCY_MAX_BOOST = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_RECENCY_BOOST ?? "0.08"));
const RISING_MONTHS = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_RISING_MONTHS ?? "9", 10) || 9);

function recencyBoost(ageDays: number | null): number {
  if (ageDays == null || ageDays < 0) return 0;
  const windowDays = RECENCY_MONTHS * 30;
  if (ageDays >= windowDays) return 0;
  return RECENCY_MAX_BOOST * (1 - ageDays / windowDays);
}

// Upper bound on how many catalogue rows we cosine per request. The catalogue
// starts small; ordering by stars means the cap keeps the canonical libraries
// when it grows. Bump if the catalogue gets large and recall suffers.
const SCAN_CAP = Math.max(100, parseInt(process.env.REPLEN_CATALOGUE_SCAN_CAP ?? "4000", 10) || 4000);

export async function catalogueMatches(opts: {
  projectEmbedding: number[] | null;
  projectFacets: FacetEmbedding[];
  minCosine: number;
  competitorCentroid: number;
  facetLead: number;
  excludeFullNames: Set<string>; // lowercased owner/name already surfaced or excluded
  projectLanguages: Set<string>;  // lowercased; for runtime-compatibility gating
  knownDeps: Set<string>;         // lowercased dep tokens the project already uses — don't suggest back
  limit: number;
}): Promise<CatalogueMatch[]> {
  const { projectEmbedding, projectFacets, minCosine, competitorCentroid, facetLead, excludeFullNames, projectLanguages, knownDeps, limit } = opts;
  if (!projectEmbedding && projectFacets.length === 0) return [];

  const rows = await db
    .select()
    .from(schema.catalogueRepos)
    .where(isNotNull(schema.catalogueRepos.embedding))
    .orderBy(desc(schema.catalogueRepos.stars))
    .limit(SCAN_CAP);

  const out: CatalogueMatch[] = [];
  for (const r of rows) {
    if (excludeFullNames.has(r.fullName.toLowerCase())) continue;
    // Already a dependency of this project (or its product) — suggesting a
    // library you already use is noise. Match by repo name OR owner.
    if (knownDeps.size > 0 && (knownDeps.has(r.name.toLowerCase()) || knownDeps.has(r.owner.toLowerCase()))) continue;
    const emb = parseStoredEmbedding(r.embedding);
    if (!emb) continue;

    const centroidCos = projectEmbedding ? cosineSimilarity(projectEmbedding, emb) : NaN;
    const cVal = Number.isFinite(centroidCos) ? centroidCos : -Infinity;

    let bestFacet = -Infinity;
    let bestFacetLabel: string | null = null;
    let bestFacetRepo: string | undefined;
    for (const f of projectFacets) {
      const s = cosineSimilarity(f.vec, emb);
      if (Number.isFinite(s) && s > bestFacet) { bestFacet = s; bestFacetLabel = f.label; bestFacetRepo = f.repo; }
    }

    const cosine = Math.max(cVal, bestFacet);
    // Runtime compatibility: exclude libraries you can't use (an Android job
    // queue for a Node bot); soft-penalise cross-language so it doesn't outrank
    // a same-language fit.
    const langPen = languagePenalty(projectLanguages, r.primaryLanguage);
    if (langPen === Infinity) continue;
    if (!Number.isFinite(cosine) || cosine - langPen < minCosine) continue;

    const facetLeads = Number.isFinite(bestFacet) && bestFacet >= cVal + facetLead;
    // Competitor suppression: an app that matches the whole project (high
    // centroid) without leading on a specific capability is a competitor.
    if (r.repoShape === "app" && Number.isFinite(centroidCos) && centroidCos >= competitorCentroid && !facetLeads) continue;

    // Library-vs-hype: skip viral experiments + curated content outright (a
    // classified row that isn't adoptable). Unclassified (null) is allowed.
    const kind = (r.kind ?? "unknown") as RepoKind;
    if (r.kind && !KEEP_KINDS.has(kind)) continue;

    const facetLed = bestFacetLabel !== null && Number.isFinite(bestFacet) && bestFacet >= cVal;
    const matchedFacet = facetLed ? bestFacetLabel : null;
    const matchedRepo = facetLed ? (bestFacetRepo ?? null) : null;
    let topics: string[] = [];
    try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { /* ignore */ }

    const ageDays = r.createdAt ? Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000) : null;
    // Recency only elevates genuine libraries/frameworks — a fresh app is more
    // likely a competitor, and content/experiments are already excluded.
    const recencyEligible = RISING_KINDS.has(kind);
    out.push({
      fullName: r.fullName, owner: r.owner, name: r.name, description: r.description,
      url: r.url, stars: r.stars, language: r.primaryLanguage, license: r.license,
      topics, repoShape: r.repoShape, cosine, matchedFacet, matchedRepo,
      ageDays, rising: recencyEligible && ageDays != null && ageDays <= RISING_MONTHS * 30,
    });
  }

  // Rank by relevance + recency − cross-language penalty: a fresh same-language
  // fit ranks above a stale or cross-language one.
  const score = (m: CatalogueMatch) => m.cosine + (m.rising ? recencyBoost(m.ageDays) : 0) - languagePenalty(projectLanguages, m.language);
  out.sort((a, b) => score(b) - score(a));
  return out.slice(0, limit);
}

export type AdjacentMatch = CatalogueMatch & {
  adjacentTo: string;       // the project capability this is adjacent to
  adjacentCapability: string; // the catalogue capability the library provides
};

// Phase 7 — capability adjacency. Find catalogue capabilities whose vector is
// NEAR but DISTINCT from one of the project's capabilities (the project doesn't
// have it, but it's in the neighbourhood), and surface the best library for
// each as an exploratory suggestion. Gated to a band (too close = the project
// effectively already has it; too far = unrelated) and capped tight — this is
// the "you don't use this yet, but it could help" feature, not a firehose.
export async function adjacentMatches(opts: {
  projectFacets: FacetEmbedding[];
  ownedCapabilities: Set<string>; // lowercased labels the project already has (its own facets)
  excludeFullNames: Set<string>;
  adjLo: number;
  adjHi: number;
  maxCapabilities: number;
  competitorCentroid: number;
  limit: number;
}): Promise<AdjacentMatch[]> {
  const { projectFacets, ownedCapabilities, excludeFullNames, adjLo, adjHi, maxCapabilities, limit } = opts;
  if (projectFacets.length === 0) return [];

  const caps = await db
    .select()
    .from(schema.catalogueCapabilities)
    .where(isNotNull(schema.catalogueCapabilities.embedding));

  // Rank candidate adjacent capabilities by how close they sit to the project.
  const adj: Array<{ label: string; nearest: string; cos: number }> = [];
  for (const c of caps) {
    if (ownedCapabilities.has(c.label.toLowerCase())) continue; // already a project capability
    const v = parseStoredEmbedding(c.embedding);
    if (!v) continue;
    let best = -Infinity;
    let nearest: string | null = null;
    for (const f of projectFacets) {
      const s = cosineSimilarity(v, f.vec);
      if (Number.isFinite(s) && s > best) { best = s; nearest = f.label; }
    }
    if (nearest !== null && best >= adjLo && best <= adjHi) adj.push({ label: c.label, nearest, cos: best });
  }
  adj.sort((a, b) => b.cos - a.cos);
  const top = adj.slice(0, maxCapabilities);
  if (top.length === 0) return [];

  // Pull the best library for each adjacent capability (one per capability).
  const repos = await db
    .select()
    .from(schema.catalogueRepos)
    .where(isNotNull(schema.catalogueRepos.embedding))
    .orderBy(desc(schema.catalogueRepos.stars))
    .limit(SCAN_CAP);

  const out: AdjacentMatch[] = [];
  const used = new Set<string>();
  for (const a of top) {
    for (const r of repos) {
      const fn = r.fullName.toLowerCase();
      if (excludeFullNames.has(fn) || used.has(fn)) continue;
      if (r.repoShape === "app") continue; // don't pitch a competitor app as exploratory
      let rcaps: string[] = [];
      try { rcaps = r.capabilities ? JSON.parse(r.capabilities) : []; } catch { /* ignore */ }
      if (!rcaps.map((x) => x.toLowerCase()).includes(a.label.toLowerCase())) continue;
      let topics: string[] = [];
      try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { /* ignore */ }
      used.add(fn);
      out.push({
        fullName: r.fullName, owner: r.owner, name: r.name, description: r.description,
        url: r.url, stars: r.stars, language: r.primaryLanguage, license: r.license,
        topics, repoShape: r.repoShape, cosine: a.cos, matchedFacet: null, matchedRepo: null,
        ageDays: r.createdAt ? Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000) : null,
        rising: false,
        adjacentTo: a.nearest, adjacentCapability: a.label,
      });
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}
