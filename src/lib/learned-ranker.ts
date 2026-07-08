// Serving side of the learned ranker (workstream A, slice 2). The trainer
// (src/cli/train-ranker.ts) fits an L2-regularised logistic over a cheap feature
// vector and persists the winning model to `ranker_weights`. Here we load the
// active model and score a candidate at rank time — a single dot-product +
// sigmoid, no LLM, microseconds. Serving is FLAG-GATED (REPLEN_LEARNED_RANK) and
// falls back to the hand-tuned rank when no model is active (cold start), so a
// fresh install / a user below the label guardrail is byte-identical to today.
//
// The feature vector + standardization MUST mirror train-ranker.ts exactly:
//   FEATURES = [cosine, facet_prior, covered, position, log_stars]
//   x_std    = [(cosine-mean0)/sd0, facet_prior-mean1, covered, (position-mean3)/sd3, (log1p(stars)-mean4)/sd4]
//   score    = sigmoid(w · x_std + bias)
// facet_prior comes from the per-facet rates the trainer persisted (unseen facet
// → base rate). position is CIRCULAR at serve time (it IS the ordering we're
// producing), so we neutralise it to the training mean → its standardized value
// is 0 and it contributes only through the bias. This is deliberate: re-feeding a
// stale position would let the previous ranking pin the new one.

import { and, eq, isNull, or, desc } from "drizzle-orm";
import { db, schema } from "../db/client";

export type LearnedRankerModel = {
  featureNames: string[];
  weights: number[]; // [w_cosine, w_facet_prior, w_covered, w_position, w_log_stars, bias]
  mean: number[];
  sd: number[];
  base: number;
  facetPriors: Record<string, number>;
  // The gate: how much triage history each facet has (confidence), a cosine-only
  // logistic [w_cosine_std, bias] for the cold-facet fallback, and the saturation
  // count at which a facet is fully trusted. When a facet's history is thin the
  // score blends toward the cosine-only prob so the learned model can't regress on
  // capabilities it has barely seen. Empty/absent ⇒ ungated (legacy model).
  facetCounts: Record<string, number>;
  cosineOnly: number[] | null; // [w, bias] over standardized cosine, or null (ungated)
  sat: number;
  userId: number | null; // the model's owner (null = global pooled)
  auc: number | null;
};

// Must match train-ranker.ts `nf` byte-for-byte so facetPriors keys line up.
const nf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function learnedRankEnabled(): boolean {
  const v = (process.env.REPLEN_LEARNED_RANK ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Load the active model for a user, preferring the user's PERSONAL model over the
// global pooled one (userId null). Returns null when no active model exists — the
// caller then keeps the hand-tuned rank (cold-start fallback).
export async function loadActiveRankerModel(userId: number): Promise<LearnedRankerModel | null> {
  const rows = await db
    .select()
    .from(schema.rankerWeights)
    .where(and(eq(schema.rankerWeights.active, true), or(eq(schema.rankerWeights.userId, userId), isNull(schema.rankerWeights.userId))))
    .orderBy(desc(schema.rankerWeights.userId)) // non-null (personal) sorts before null (global) under desc
    .all();
  if (!rows.length) return null;
  // Prefer the personal model; fall back to global.
  const chosen = rows.find((r) => r.userId === userId) ?? rows.find((r) => r.userId === null);
  if (!chosen) return null;
  return parseStoredModel(chosen);
}

// Parse a stored ranker_weights row into a model. Exported so the trainer can
// re-measure the incumbent on the CURRENT label set using the exact serving math
// (no duplicated scoring logic → no drift). Returns null on malformed rows.
export function parseStoredModel(row: typeof schema.rankerWeights.$inferSelect): LearnedRankerModel | null {
  try {
    const featureNames = JSON.parse(row.featureNames) as string[];
    const weights = JSON.parse(row.weights) as number[];
    const std = JSON.parse(row.standardization) as {
      mean: number[]; sd: number[]; base: number;
      facetPriors?: Record<string, number>; facetCounts?: Record<string, number>;
      cosineOnly?: number[]; sat?: number;
    };
    if (!Array.isArray(weights) || weights.length !== featureNames.length + 1) return null;
    if (!Array.isArray(std.mean) || !Array.isArray(std.sd)) return null;
    return {
      featureNames,
      weights,
      mean: std.mean,
      sd: std.sd,
      base: typeof std.base === "number" ? std.base : 0,
      facetPriors: std.facetPriors ?? {},
      facetCounts: std.facetCounts ?? {},
      cosineOnly: Array.isArray(std.cosineOnly) && std.cosineOnly.length === 2 ? std.cosineOnly : null,
      sat: typeof std.sat === "number" && std.sat > 0 ? std.sat : 4,
      userId: row.userId,
      auc: row.auc,
    };
  } catch {
    return null;
  }
}

// Score one candidate in [0,1]. `facet` is the matched capability label (raw, un-
// normalised) or null; `covered` is the SAME coveredCaps membership the trainer
// logged (isCovered at match time); `stars` is the repo's star count (null → 0,
// matching the trainer's `stars ?? 0`).
//
// THE GATE: the learned probability (sL) is blended with a cosine-only probability
// (sC) by facet confidence conf = min(1, facet_history / sat). A well-triaged facet
// (conf≈1) uses the full learned model — the exploit win. A cold/unseen/centroid
// facet (conf≈0) falls back to the cosine-only prob so the learned model can't
// throw cosine away and regress on a capability it has barely seen. Both are
// calibrated probabilities in [0,1], so the blend and every cross-candidate
// comparison stay on one scale. A legacy model with no cosineOnly is ungated.
export function learnedRankScore(
  m: LearnedRankerModel,
  feats: { cosine: number; facet: string | null; covered: boolean; stars: number | null },
): number {
  const zcos = (feats.cosine - m.mean[0]) / (m.sd[0] || 1);
  const facetKey = feats.facet != null ? nf(feats.facet) : "";
  const facetPrior = facetKey && m.facetPriors[facetKey] != null ? m.facetPriors[facetKey] : m.base;
  const x = [
    zcos,
    facetPrior - m.mean[1],
    feats.covered ? 1 : 0,
    0, // position neutralised (circular at serve) → standardized 0
    (Math.log1p(feats.stars ?? 0) - m.mean[4]) / (m.sd[4] || 1),
  ];
  let z = m.weights[m.weights.length - 1]; // bias
  for (let k = 0; k < x.length; k++) z += m.weights[k] * x[k];
  const sL = sigmoid(z);
  if (!m.cosineOnly) return sL; // legacy ungated model
  const sC = sigmoid(m.cosineOnly[0] * zcos + m.cosineOnly[1]);
  const conf = Math.min(1, (facetKey ? (m.facetCounts[facetKey] ?? 0) : 0) / (m.sat || 4));
  return conf * sL + (1 - conf) * sC;
}
