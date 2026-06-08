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
