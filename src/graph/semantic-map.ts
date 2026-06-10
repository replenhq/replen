// Semantic map — position by MEANING instead of links. Projects (centroid
// embeddings), capabilities (facet centroids), and evaluated candidates
// (catalogue embeddings) are projected from 1536-d to 2-d with plain PCA
// (top-2 principal components via power iteration — deterministic, no deps,
// no Math.random; the init vector is a fixed sinusoid). Clusters = themes;
// empty regions = blind spots; a candidate dot near a capability is a match
// you can SEE.

import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { parseStoredEmbedding, parseStoredFacetEmbeddings } from "../lib/embeddings";

export type MapPoint = { nodeKey: string; kind: string; x: number; y: number };

function powerIteration(vectors: number[][], deflate: number[] | null): number[] {
  const dim = vectors[0].length;
  let v = new Array(dim).fill(0).map((_, i) => Math.sin(i + 1)); // deterministic init
  const normalize = (a: number[]) => {
    const m = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
    return a.map((x) => x / m);
  };
  v = normalize(v);
  if (deflate) {
    // remove the first component's direction so we converge to the second
    const d = v.reduce((s, x, i) => s + x * deflate[i], 0);
    v = normalize(v.map((x, i) => x - d * deflate[i]));
  }
  for (let iter = 0; iter < 40; iter++) {
    // w = Σ (x·v) x  — covariance-vector product without materializing C
    const w = new Array(dim).fill(0);
    for (const x of vectors) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += x[i] * v[i];
      for (let i = 0; i < dim; i++) w[i] += dot * x[i];
    }
    if (deflate) {
      const d = w.reduce((s, x, i) => s + x * deflate[i], 0);
      for (let i = 0; i < dim; i++) w[i] -= d * deflate[i];
    }
    v = normalize(w);
  }
  return v;
}

export async function computeSemanticMap(userId: number): Promise<MapPoint[]> {
  const entries: Array<{ nodeKey: string; kind: string; vec: number[] }> = [];

  const projects = await db.select().from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  const capSums = new Map<string, { sum: number[]; n: number; label: string }>();
  for (const p of projects) {
    if (!p.active || !p.included) continue;
    const centroid = parseStoredEmbedding(p.embedding ?? null);
    if (centroid) entries.push({ nodeKey: p.slug, kind: "project", vec: centroid });
    for (const f of parseStoredFacetEmbeddings(p.facetEmbeddings ?? null)) {
      const key = f.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!key) continue;
      const acc = capSums.get(key) ?? { sum: new Array(f.vec.length).fill(0), n: 0, label: f.label };
      for (let i = 0; i < f.vec.length; i++) acc.sum[i] += f.vec[i];
      acc.n++;
      capSums.set(key, acc);
    }
  }
  for (const [key, acc] of capSums) {
    entries.push({ nodeKey: key, kind: "capability", vec: acc.sum.map((x) => x / acc.n) });
  }

  // Evaluated candidates with catalogue embeddings.
  const candNodes = await db.select({ nodeKey: schema.graphNodes.nodeKey, data: schema.graphNodes.data })
    .from(schema.graphNodes)
    .where(eq(schema.graphNodes.userId, userId));
  const fullNames: string[] = [];
  const keyByFullName = new Map<string, string>();
  for (const n of candNodes) {
    try {
      const d = n.data ? JSON.parse(n.data) : {};
      if (d.fullName) { fullNames.push(d.fullName); keyByFullName.set(String(d.fullName).toLowerCase(), n.nodeKey); }
    } catch { /* */ }
  }
  if (fullNames.length) {
    const cats = await db.select({ fullName: schema.catalogueRepos.fullName, embedding: schema.catalogueRepos.embedding })
      .from(schema.catalogueRepos).where(inArray(schema.catalogueRepos.fullName, fullNames));
    for (const c of cats) {
      const v = parseStoredEmbedding(c.embedding ?? null);
      const key = keyByFullName.get(c.fullName.toLowerCase());
      if (v && key) entries.push({ nodeKey: key, kind: "candidate", vec: v });
    }
  }
  if (entries.length < 3) return [];

  // Centre, project onto top-2 PCs, scale to a stable canvas range.
  const dim = entries[0].vec.length;
  const mean = new Array(dim).fill(0);
  for (const e of entries) for (let i = 0; i < dim; i++) mean[i] += e.vec[i] / entries.length;
  const centred = entries.map((e) => e.vec.map((x, i) => x - mean[i]));
  const pc1 = powerIteration(centred, null);
  const pc2 = powerIteration(centred, pc1);
  const raw = centred.map((v) => ({
    x: v.reduce((s, x, i) => s + x * pc1[i], 0),
    y: v.reduce((s, x, i) => s + x * pc2[i], 0),
  }));
  const maxAbs = Math.max(...raw.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]), 1e-9);
  const SCALE = 320;
  return entries.map((e, i) => ({
    nodeKey: e.nodeKey, kind: e.kind,
    x: (raw[i].x / maxAbs) * SCALE,
    y: (raw[i].y / maxAbs) * SCALE,
  }));
}
