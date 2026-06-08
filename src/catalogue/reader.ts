// Phase 5 — catalogue reader. Matches the shared capability catalogue against a
// scoped project, using the SAME faceted scoring as the per-user pool: best of
// (project centroid, project facets) cosine, with the same relevance floor and
// competitor suppression. So the catalogue surfaces a library that fills one of
// the project's capabilities even when the project's own targeted search hasn't
// fetched it yet — without becoming a trending firehose.

import { db, schema } from "../db/client";
import { desc, isNotNull } from "drizzle-orm";
import { cosineSimilarity, parseStoredEmbedding, type FacetEmbedding } from "../lib/embeddings";

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
};

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
  limit: number;
}): Promise<CatalogueMatch[]> {
  const { projectEmbedding, projectFacets, minCosine, competitorCentroid, facetLead, excludeFullNames, limit } = opts;
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
    const emb = parseStoredEmbedding(r.embedding);
    if (!emb) continue;

    const centroidCos = projectEmbedding ? cosineSimilarity(projectEmbedding, emb) : NaN;
    const cVal = Number.isFinite(centroidCos) ? centroidCos : -Infinity;

    let bestFacet = -Infinity;
    let bestFacetLabel: string | null = null;
    for (const f of projectFacets) {
      const s = cosineSimilarity(f.vec, emb);
      if (Number.isFinite(s) && s > bestFacet) { bestFacet = s; bestFacetLabel = f.label; }
    }

    const cosine = Math.max(cVal, bestFacet);
    if (!Number.isFinite(cosine) || cosine < minCosine) continue;

    const facetLeads = Number.isFinite(bestFacet) && bestFacet >= cVal + facetLead;
    // Competitor suppression: an app that matches the whole project (high
    // centroid) without leading on a specific capability is a competitor.
    if (r.repoShape === "app" && Number.isFinite(centroidCos) && centroidCos >= competitorCentroid && !facetLeads) continue;

    const matchedFacet = bestFacetLabel !== null && Number.isFinite(bestFacet) && bestFacet >= cVal ? bestFacetLabel : null;
    let topics: string[] = [];
    try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { /* ignore */ }

    out.push({
      fullName: r.fullName, owner: r.owner, name: r.name, description: r.description,
      url: r.url, stars: r.stars, language: r.primaryLanguage, license: r.license,
      topics, repoShape: r.repoShape, cosine, matchedFacet,
    });
  }

  out.sort((a, b) => b.cosine - a.cosine);
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
        topics, repoShape: r.repoShape, cosine: a.cos, matchedFacet: null,
        adjacentTo: a.nearest, adjacentCapability: a.label,
      });
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}
