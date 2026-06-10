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

export type MapPoint = { nodeKey: string; kind: string; x: number; y: number; z: number };

function powerIteration(vectors: number[][], deflate: number[][]): number[] {
  const dim = vectors[0].length;
  let v = new Array(dim).fill(0).map((_, i) => Math.sin(i + 1)); // deterministic init
  const normalize = (a: number[]) => {
    const m = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
    return a.map((x) => x / m);
  };
  const removeComponents = (a: number[]): number[] => {
    let out = a;
    for (const dvec of deflate) {
      const d = out.reduce((s, x, i) => s + x * dvec[i], 0);
      out = out.map((x, i) => x - d * dvec[i]);
    }
    return out;
  };
  v = normalize(removeComponents(v));
  for (let iter = 0; iter < 40; iter++) {
    // w = Σ (x·v) x  — covariance-vector product without materializing C
    const w = new Array(dim).fill(0);
    for (const x of vectors) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += x[i] * v[i];
      for (let i = 0; i < dim; i++) w[i] += dot * x[i];
    }
    v = normalize(removeComponents(w));
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

  // Evaluated candidates AND open suggestions with catalogue embeddings —
  // both carry data.fullName; the node's own kind rides through so the map
  // points land on the right node ids.
  const candNodes = await db.select({ kind: schema.graphNodes.kind, nodeKey: schema.graphNodes.nodeKey, data: schema.graphNodes.data })
    .from(schema.graphNodes)
    .where(eq(schema.graphNodes.userId, userId));
  const fullNames: string[] = [];
  const nodeByFullName = new Map<string, { kind: string; nodeKey: string }>();
  for (const n of candNodes) {
    if (n.kind !== "candidate" && n.kind !== "suggestion") continue;
    try {
      const d = n.data ? JSON.parse(n.data) : {};
      if (d.fullName) { fullNames.push(d.fullName); nodeByFullName.set(String(d.fullName).toLowerCase(), { kind: n.kind, nodeKey: n.nodeKey }); }
    } catch { /* */ }
  }
  if (fullNames.length) {
    const cats = await db.select({ fullName: schema.catalogueRepos.fullName, embedding: schema.catalogueRepos.embedding })
      .from(schema.catalogueRepos).where(inArray(schema.catalogueRepos.fullName, fullNames));
    for (const c of cats) {
      const v = parseStoredEmbedding(c.embedding ?? null);
      const node = nodeByFullName.get(c.fullName.toLowerCase());
      if (v && node) entries.push({ nodeKey: node.nodeKey, kind: node.kind, vec: v });
    }
  }
  if (entries.length < 3) return [];

  // Centre, project onto top-3 PCs (the third is the 3D view's depth axis),
  // scale to a stable canvas range.
  const dim = entries[0].vec.length;
  const mean = new Array(dim).fill(0);
  for (const e of entries) for (let i = 0; i < dim; i++) mean[i] += e.vec[i] / entries.length;
  const centred = entries.map((e) => e.vec.map((x, i) => x - mean[i]));
  const pc1 = powerIteration(centred, []);
  const pc2 = powerIteration(centred, [pc1]);
  const pc3 = powerIteration(centred, [pc1, pc2]);
  const raw = centred.map((v) => ({
    x: v.reduce((s, x, i) => s + x * pc1[i], 0),
    y: v.reduce((s, x, i) => s + x * pc2[i], 0),
    z: v.reduce((s, x, i) => s + x * pc3[i], 0),
  }));
  const maxAbs = Math.max(...raw.flatMap((p) => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)]), 1e-9);
  const SCALE = 320;
  return entries.map((e, i) => ({
    nodeKey: e.nodeKey, kind: e.kind,
    x: (raw[i].x / maxAbs) * SCALE,
    y: (raw[i].y / maxAbs) * SCALE,
    z: (raw[i].z / maxAbs) * SCALE,
  }));
}
