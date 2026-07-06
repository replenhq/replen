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
// Cap the negative (skip) mass at this fraction of the positive mass. In the
// common case (few skips) the skip contribution is already well below this, so
// the vector is IDENTICAL to the old raw-sum Rocchio — no ranking change. It
// only engages in the pathological case the audit flagged (skip volume so high
// the vector would flip toward the negated skip centroid and neutralise taste),
// where it clamps the negatives so positives always lead. Safe by construction.
const NEG_MASS_CAP = Math.max(0, parseFloat(process.env.REPLEN_TASTE_NEG_CAP ?? "0.9"));

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

  // Per-CLASS weights. Positives (scoped full strength, related projects'
  // positives at half weight) and negatives (scoped skips) are accumulated
  // separately ONLY so the negative mass can later be bounded (see NEG_MASS_CAP);
  // the arithmetic is otherwise the old raw-sum Rocchio.
  const posW = new Map<number, number>(); // repoId → summed positive weight
  const negW = new Map<number, number>(); // repoId → summed negative weight
  let positives = 0;
  for (const e of latest.values()) {
    const positive = e.verdict === "adopt" || e.verdict === "port";
    if (e.projectId != null && e.projectId === scopedProjectId) {
      if (positive) { posW.set(e.repoId, (posW.get(e.repoId) ?? 0) + 1); positives++; }
      else if (e.verdict === "skip") negW.set(e.repoId, (negW.get(e.repoId) ?? 0) + 1);
    } else if (positive && (e.projectId == null || relatedIds.has(e.projectId) || scopedProjectId == null)) {
      posW.set(e.repoId, (posW.get(e.repoId) ?? 0) + RELATED_WEIGHT);
      positives++;
    }
  }
  if (positives < MIN_POSITIVES) return null;

  // Resolve embeddings: catalogue by fullName first, candidates as fallback.
  const repoIds = [...new Set([...posW.keys(), ...negW.keys()])];
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

  // Raw weighted sums per class (exactly the old Rocchio accumulation, just
  // kept in two vectors so the negative mass can be bounded).
  const accumulate = (w: Map<number, number>): { sum: number[] | null; used: number } => {
    let sum: number[] | null = null;
    let used = 0;
    for (const [repoId, wt] of w) {
      const fn = fullNameById.get(repoId)?.toLowerCase();
      if (!fn) continue;
      const v = vecByFullName.get(fn) ?? null;
      if (!v) continue;
      if (!sum) sum = new Array(v.length).fill(0);
      for (let i = 0; i < v.length; i++) sum[i] += v[i] * wt;
      used++;
    }
    return { sum, used };
  };
  const pos = accumulate(posW);
  const neg = accumulate(negW);
  if (!pos.sum || pos.used < MIN_POSITIVES) return null;

  const l2 = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  const posMag = l2(pos.sum);
  if (!Number.isFinite(posMag) || posMag === 0) return null;

  // taste = posSum − γ·scale·negSum. scale = 1 in the common case (identical to
  // the old formula); it only shrinks when γ·‖negSum‖ would exceed NEG_MASS_CAP
  // of the positive mass, bounding the skip contribution so it can never flip
  // or neutralise the vector.
  const dim = pos.sum.length;
  let scale = 1;
  if (neg.sum) {
    const negContrib = SKIP_GAMMA * l2(neg.sum);
    if (negContrib > NEG_MASS_CAP * posMag && negContrib > 0) {
      scale = (NEG_MASS_CAP * posMag) / negContrib;
    }
  }
  const combined = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    combined[i] = pos.sum[i] - SKIP_GAMMA * scale * (neg.sum ? neg.sum[i] : 0);
  }
  const mag = l2(combined);
  if (!Number.isFinite(mag) || mag === 0) return null;
  return combined.map((x) => x / mag);
}

// Additive boost for a candidate vector against the taste vector.
export function tasteBoost(candVec: number[] | null, taste: number[] | null, weight = parseFloat(process.env.REPLEN_TASTE_BOOST ?? "0.05")): number {
  if (!candVec || !taste) return 0;
  const c = cosineSimilarity(candVec, taste);
  return Number.isFinite(c) ? Math.max(0, c) * Math.max(0, weight) : 0;
}
