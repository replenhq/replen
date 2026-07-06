// Similar-project promotion (the second half of the L4 learning loop).
//
// Signal: "a repo that earned a positive verdict (adopt / port) from a user
// whose project is semantically close to YOURS is probably worth your look —
// even if it never landed in your own candidate pool." This is how a good
// triage propagates value across tenants: good-for-a-project-like-yours.
//
// Ranking basis: project-to-project cosine similarity. We surface the repo
// scored by how similar the endorsing project is to the caller's project —
// that IS the relevance proxy here ("how much like me was the project this
// helped?"). Capped hard so promotions augment rather than flood the caller's
// own matches.
//
// Privacy: we read other users' project embeddings (derived vectors) and
// verdicts only to compute similarity. The OUTPUT exposes nothing but the
// public repo and an aggregate reason — never another user's identity,
// project name, or writeup.

import { db, schema } from "@/db/client";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { cosineSimilarity, parseStoredEmbedding } from "@/lib/embeddings";

export type PromotedCandidate = {
  candidateId: number | null;
  repoId: number;
  repo: string;
  url: string | null;
  description: string | null;
  stars: number | null;
  language: string | null;
  license: string | null;
  topics: string[];
  repoShape: string | null;
  source: string;
  postedAt: string | null;
  pushedAt: string | null;
  whyShortlisted: string;
  cosine: number; // project-to-project similarity (the promotion signal)
};

export function promoteConfig() {
  return {
    // Minimum project-to-project cosine for a promotion to be eligible.
    similarCosine: Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_SIMILAR_PROJECT_COSINE ?? "0.6"))),
    // Hard cap on promotions per request — they augment, never flood.
    maxPromotions: Math.max(0, parseInt(process.env.REPLEN_PROMOTE_MAX ?? "3", 10) || 3),
    // Bound on how many recent positive triages we scan per request.
    scanLimit: Math.max(100, parseInt(process.env.REPLEN_PROMOTE_SCAN ?? "2000", 10) || 2000),
    // k-anonymity: require >=2 DISTINCT other users to have endorsed a repo
    // before it can be promoted, so a single tenant's verdict + their project
    // similarity never crosses over. Floored at 2, matching the catalogue K.
    minEndorsers: Math.max(2, parseInt(process.env.REPLEN_PROMOTE_MIN_USERS ?? "2", 10) || 2),
  };
}

// Find repos to promote to `userId`'s scoped project (whose embedding is
// `projectEmbedding`). Excludes anything already excluded for this user
// (their own pool, hidden/skip/cool-off/demoted — pass them in `excludeRepoIds`).
export async function findSimilarProjectPromotions(opts: {
  userId: number;
  projectEmbedding: number[];
  excludeRepoIds: Set<number>;
}): Promise<PromotedCandidate[]> {
  const { userId, projectEmbedding, excludeRepoIds } = opts;
  const { similarCosine, maxPromotions, scanLimit, minEndorsers } = promoteConfig();
  if (maxPromotions === 0) return [];

  // Positive verdicts from OTHER users, with the endorsing project's embedding.
  const rows = await db
    .select({
      repoId: schema.triageEvents.repoId,
      uid: schema.triageEvents.userId,
      projEmbedding: schema.projectProfiles.embedding,
    })
    .from(schema.triageEvents)
    .innerJoin(schema.projectProfiles, eq(schema.projectProfiles.id, schema.triageEvents.projectId))
    .innerJoin(schema.users, eq(schema.users.id, schema.triageEvents.userId))
    .where(and(
      ne(schema.triageEvents.userId, userId),
      // Exclude the synthetic test cohort — their endorsements must never
      // promote a repo into a real user's pool.
      ne(schema.users.role, "test"),
      inArray(schema.triageEvents.verdict, ["adopt", "port"]),
      isNotNull(schema.projectProfiles.embedding),
    ))
    .orderBy(desc(schema.triageEvents.createdAt))
    .limit(scanLimit);

  // Best (max) project-similarity per repo across its endorsing projects.
  const bestSimByRepo = new Map<number, number>();
  const endorsersByRepo = new Map<number, Set<number>>();
  for (const r of rows) {
    if (excludeRepoIds.has(r.repoId)) continue;
    const emb = parseStoredEmbedding(r.projEmbedding ?? null);
    if (!emb) continue;
    const sim = cosineSimilarity(projectEmbedding, emb);
    if (!Number.isFinite(sim) || sim < similarCosine) continue;
    const prev = bestSimByRepo.get(r.repoId);
    if (prev === undefined || sim > prev) bestSimByRepo.set(r.repoId, sim);
    let us = endorsersByRepo.get(r.repoId);
    if (!us) { us = new Set(); endorsersByRepo.set(r.repoId, us); }
    us.add(r.uid);
  }
  // k-anonymity: drop any repo endorsed by fewer than `minEndorsers` DISTINCT
  // other users, so a single tenant's verdict + project cosine can't be
  // reconstructed from a promotion. Degrades silently to nothing.
  for (const [repoId, users] of endorsersByRepo) {
    if (users.size < minEndorsers) bestSimByRepo.delete(repoId);
  }
  if (bestSimByRepo.size === 0) return [];

  // Top N by similarity.
  const top = [...bestSimByRepo.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPromotions);
  const topRepoIds = top.map(([repoId]) => repoId);

  // Hydrate repo metadata.
  const repoRows = await db
    .select()
    .from(schema.repos)
    .where(inArray(schema.repos.id, topRepoIds));
  const repoById = new Map(repoRows.map((r) => [r.id, r]));

  const out: PromotedCandidate[] = [];
  for (const [repoId, sim] of top) {
    const r = repoById.get(repoId);
    if (!r) continue;
    // Bucket to the nearest 5% so the reason line isn't a precise cross-user
    // project-similarity oracle over repeated queries.
    const pct = (Math.round((sim * 100) / 5) * 5).toString();
    out.push({
      candidateId: null,
      repoId,
      repo: `${r.owner}/${r.name}`,
      url: r.url,
      description: r.description,
      stars: r.stars,
      language: r.primaryLanguage,
      license: r.license,
      // The repos table doesn't carry topics/shape (those live per-candidate);
      // a promoted repo isn't in this user's candidate pool, so we surface
      // without them rather than fabricate.
      topics: [],
      repoShape: null,
      source: "cross-user-promote",
      postedAt: null,
      pushedAt: r.pushedAt?.toISOString() ?? null,
      whyShortlisted: `endorsed by a similar project (${pct}% alike) — adopted or ported by another team working on something like this`,
      cosine: sim,
    });
  }
  return out;
}
