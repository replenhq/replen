// Risk + replacement, fused. When a watch lens flags a repo as risky (dead /
// archived upstream, security trouble), Replen can answer the obvious next
// question in the same breath: the catalogue holds maintained libraries in
// the same embedding space, and repo_quality knows what users with similar
// projects actually adopted. Deterministic — cosine over the catalogue plus
// the cross-user adoption tallies, no LLM.

import { and, desc, eq, gte, like } from "drizzle-orm";
import { db, schema } from "../db/client";
import { cosineSimilarity, parseStoredEmbedding } from "./embeddings";
import { KEEP_KINDS, type RepoKind } from "../catalogue/classify";

const MIN_SIMILARITY = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_ALT_MIN_COSINE ?? "0.55")));
const MAINTAINED_DAYS = Math.max(30, parseInt(process.env.REPLEN_ALT_MAINTAINED_DAYS ?? "365", 10) || 365);
// Each adopting/porting user is social proof; weight it into the ranking so
// a battle-tested alternative outranks a marginally-more-similar unknown.
const ADOPTION_BOOST = Math.max(0, parseFloat(process.env.REPLEN_ALT_ADOPTION_BOOST ?? "0.03"));

export type Alternative = { fullName: string; url: string | null; stars: number | null; adoptedBy: number; similarity: number };

// Embedding for the risky repo: catalogue first (canonical), then the user's
// candidate pool (feed items for known repos usually have one).
async function embeddingFor(fullName: string): Promise<number[] | null> {
  const cat = await db.select({ embedding: schema.catalogueRepos.embedding }).from(schema.catalogueRepos)
    .where(eq(schema.catalogueRepos.fullName, fullName)).get();
  const fromCat = parseStoredEmbedding(cat?.embedding ?? null);
  if (fromCat) return fromCat;
  const cand = await db.select({ embedding: schema.candidates.embedding }).from(schema.candidates)
    .where(like(schema.candidates.githubUrl, `%github.com/${fullName}%`))
    .orderBy(desc(schema.candidates.id)).limit(1).get();
  return parseStoredEmbedding(cand?.embedding ?? null);
}

export async function alternativesFor(fullName: string, limit = 3): Promise<Alternative[]> {
  const targetVec = await embeddingFor(fullName);
  if (!targetVec) return [];

  // Cross-user adoption tallies, keyed by fullName.
  const quality = await db
    .select({ owner: schema.repos.owner, name: schema.repos.name, adopt: schema.repoQuality.adoptUsers, port: schema.repoQuality.portUsers })
    .from(schema.repoQuality)
    .innerJoin(schema.repos, eq(schema.repoQuality.repoId, schema.repos.id))
    .where(gte(schema.repoQuality.totalUsers, 1));
  const adoptedBy = new Map<string, number>();
  for (const q of quality) adoptedBy.set(`${q.owner}/${q.name}`.toLowerCase(), q.adopt + q.port);

  const maintainedSince = new Date(Date.now() - MAINTAINED_DAYS * 86400e3);
  const rows = await db
    .select({
      fullName: schema.catalogueRepos.fullName,
      url: schema.catalogueRepos.url,
      stars: schema.catalogueRepos.stars,
      embedding: schema.catalogueRepos.embedding,
      kind: schema.catalogueRepos.kind,
      pushedAt: schema.catalogueRepos.pushedAt,
    })
    .from(schema.catalogueRepos);

  const self = fullName.toLowerCase();
  const scored: Array<Alternative & { score: number }> = [];
  for (const r of rows) {
    if (r.fullName.toLowerCase() === self) continue;
    if (r.kind && !KEEP_KINDS.has(r.kind as RepoKind)) continue;
    if (r.pushedAt != null && r.pushedAt < maintainedSince) continue; // the whole point: maintained
    const vec = parseStoredEmbedding(r.embedding ?? null);
    if (!vec) continue;
    const sim = cosineSimilarity(targetVec, vec);
    if (!Number.isFinite(sim) || sim < MIN_SIMILARITY) continue;
    const adopted = adoptedBy.get(r.fullName.toLowerCase()) ?? 0;
    scored.push({
      fullName: r.fullName, url: r.url, stars: r.stars, adoptedBy: adopted, similarity: sim,
      score: sim + Math.min(adopted, 5) * ADOPTION_BOOST,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ score: _score, ...alt }) => alt);
}
