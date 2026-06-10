// Rocchio relevance feedback — the per-project taste vector.
//
// taste = normalize( Σ w·v ) where adopted/ported candidates contribute +1,
// skipped candidates −γ, and adoptions from RELATED projects (graph
// RELATES_TO, passed in by the caller) contribute at half weight — your own
// portfolio's choices are a prior for each project in it. Every triage
// session moves the vector; candidates similar to what this project actually
// keeps get a small additive ranking boost. Deterministic, no LLM; with no
// history the vector is null → zero effect (degrade-gracefully, for free).

import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { parseStoredEmbedding, cosineSimilarity } from "./embeddings";

const SKIP_GAMMA = Math.max(0, parseFloat(process.env.REPLEN_TASTE_GAMMA ?? "0.5"));
const RELATED_WEIGHT = Math.max(0, parseFloat(process.env.REPLEN_TASTE_RELATED_W ?? "0.5"));
const MIN_POSITIVES = 2; // below this the signal is one anecdote, not taste

export async function loadTasteVector(
  userId: number,
  scopedProjectId: number | null,
  relatedSlugs: string[],
): Promise<number[] | null> {
  const projects = await db.select({ id: schema.projectProfiles.id, slug: schema.projectProfiles.slug })
    .from(schema.projectProfiles).where(eq(schema.projectProfiles.userId, userId));
  const relatedIds = new Set(projects.filter((p) => relatedSlugs.includes(p.slug)).map((p) => p.id));

  const events = await db.select({
    id: schema.triageEvents.id, repoId: schema.triageEvents.repoId, projectId: schema.triageEvents.projectId,
    verdict: schema.triageEvents.verdict, createdAt: schema.triageEvents.createdAt,
  }).from(schema.triageEvents).where(eq(schema.triageEvents.userId, userId));
  if (!events.length) return null;

  // Latest verdict per (project, repo) — same semantics as everywhere else.
  const latest = new Map<string, typeof events[number]>();
  for (const e of events) {
    const k = `${e.projectId ?? "g"}:${e.repoId}`;
    const prev = latest.get(k);
    const at = e.createdAt?.getTime() ?? 0;
    if (!prev || at > (prev.createdAt?.getTime() ?? 0) || (at === (prev.createdAt?.getTime() ?? 0) && e.id > prev.id)) latest.set(k, e);
  }

  // Weight per event: scoped project full strength (±), related projects'
  // POSITIVE verdicts at half weight (their skips are their context, not ours).
  const weights = new Map<number, number>(); // repoId → summed weight
  let positives = 0;
  for (const e of latest.values()) {
    const positive = e.verdict === "adopt" || e.verdict === "port";
    if (e.projectId != null && e.projectId === scopedProjectId) {
      if (positive) { weights.set(e.repoId, (weights.get(e.repoId) ?? 0) + 1); positives++; }
      else if (e.verdict === "skip") weights.set(e.repoId, (weights.get(e.repoId) ?? 0) - SKIP_GAMMA);
    } else if (positive && (e.projectId == null || relatedIds.has(e.projectId) || scopedProjectId == null)) {
      weights.set(e.repoId, (weights.get(e.repoId) ?? 0) + RELATED_WEIGHT);
      positives++;
    }
  }
  if (positives < MIN_POSITIVES) return null;

  // Resolve embeddings: catalogue by fullName first, candidates as fallback.
  const repoIds = [...weights.keys()];
  const repoRows = await db.select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name })
    .from(schema.repos).where(inArray(schema.repos.id, repoIds));
  const fullNameById = new Map(repoRows.map((r) => [r.id, `${r.owner}/${r.name}`]));
  const fullNames = [...fullNameById.values()];
  const catRows = fullNames.length
    ? await db.select({ fullName: schema.catalogueRepos.fullName, embedding: schema.catalogueRepos.embedding })
        .from(schema.catalogueRepos).where(inArray(schema.catalogueRepos.fullName, fullNames))
    : [];
  const vecByFullName = new Map<string, number[]>();
  for (const c of catRows) {
    const v = parseStoredEmbedding(c.embedding ?? null);
    if (v) vecByFullName.set(c.fullName.toLowerCase(), v);
  }
  // Fallback for repos not in the catalogue: the user's own candidate pool
  // (one pass; latest embedded row per repo wins by iteration order).
  const missing = new Set(fullNames.map((f) => f.toLowerCase()).filter((f) => !vecByFullName.has(f)));
  if (missing.size > 0) {
    const candRows = await db.select({ githubUrl: schema.candidates.githubUrl, embedding: schema.candidates.embedding })
      .from(schema.candidates).where(eq(schema.candidates.userId, userId)).orderBy(schema.candidates.id);
    for (const c of candRows) {
      if (!c.githubUrl || !c.embedding) continue;
      const m = c.githubUrl.match(/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/i);
      if (!m) continue;
      const fn = `${m[1]}/${m[2]}`.toLowerCase();
      if (!missing.has(fn)) continue;
      const v = parseStoredEmbedding(c.embedding);
      if (v) vecByFullName.set(fn, v);
    }
  }

  let sum: number[] | null = null;
  let used = 0;
  for (const [repoId, w] of weights) {
    const fn = fullNameById.get(repoId)?.toLowerCase();
    if (!fn) continue;
    const v = vecByFullName.get(fn) ?? null;
    if (!v) continue;
    if (!sum) sum = new Array(v.length).fill(0);
    for (let i = 0; i < v.length; i++) sum[i] += v[i] * w;
    used++;
  }
  if (!sum || used < MIN_POSITIVES) return null;
  const mag = Math.sqrt(sum.reduce((acc, x) => acc + x * x, 0));
  if (!Number.isFinite(mag) || mag === 0) return null;
  return sum.map((x) => x / mag);
}

// Additive boost for a candidate vector against the taste vector.
export function tasteBoost(candVec: number[] | null, taste: number[] | null, weight = parseFloat(process.env.REPLEN_TASTE_BOOST ?? "0.05")): number {
  if (!candVec || !taste) return 0;
  const c = cosineSimilarity(candVec, taste);
  return Number.isFinite(c) ? Math.max(0, c) * Math.max(0, weight) : 0;
}
