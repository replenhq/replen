// Compact Louvain community detection (single-level local-moving modularity
// optimization). Used to cluster a user's capabilities into THEMES (§5). JS, no
// Python sidecar — for a few hundred capability nodes this is more than enough;
// the Leiden upgrade only matters at research scale.

export type Edge = { a: number; b: number; w: number };

/**
 * Partition nodes into communities by maximizing modularity. Returns a map
 * nodeId → contiguous communityId (0..k-1). Disconnected nodes each get their
 * own community.
 */
export function louvain(nodeIds: number[], edges: Edge[], resolution = 1.0): Map<number, number> {
  const adj = new Map<number, Array<[number, number]>>();
  const k = new Map<number, number>();
  for (const id of nodeIds) { adj.set(id, []); k.set(id, 0); }
  let m2 = 0;
  for (const e of edges) {
    if (e.a === e.b || e.w <= 0) continue;
    adj.get(e.a)?.push([e.b, e.w]); adj.get(e.b)?.push([e.a, e.w]);
    k.set(e.a, (k.get(e.a) ?? 0) + e.w); k.set(e.b, (k.get(e.b) ?? 0) + e.w);
    m2 += 2 * e.w;
  }
  const comm = new Map<number, number>();
  nodeIds.forEach((id) => comm.set(id, id));
  if (m2 === 0) return renumber(comm, nodeIds);

  const sigmaTot = new Map<number, number>();
  nodeIds.forEach((id) => sigmaTot.set(id, k.get(id) ?? 0));

  let improved = true;
  let iter = 0;
  while (improved && iter < 100) {
    improved = false; iter++;
    for (const id of nodeIds) {
      const ki = k.get(id) ?? 0;
      const cur = comm.get(id)!;
      const wTo = new Map<number, number>();
      for (const [nb, w] of adj.get(id)!) { const cc = comm.get(nb)!; wTo.set(cc, (wTo.get(cc) ?? 0) + w); }
      sigmaTot.set(cur, (sigmaTot.get(cur) ?? 0) - ki); // pull node out of its community
      let bestC = cur;
      let bestGain = (wTo.get(cur) ?? 0) - resolution * (sigmaTot.get(cur) ?? 0) * ki / m2;
      for (const [cc, wic] of wTo) {
        if (cc === cur) continue;
        const gain = wic - resolution * (sigmaTot.get(cc) ?? 0) * ki / m2;
        if (gain > bestGain) { bestGain = gain; bestC = cc; }
      }
      sigmaTot.set(bestC, (sigmaTot.get(bestC) ?? 0) + ki);
      if (bestC !== cur) { comm.set(id, bestC); improved = true; }
    }
  }
  return renumber(comm, nodeIds);
}

function renumber(comm: Map<number, number>, nodeIds: number[]): Map<number, number> {
  const remap = new Map<number, number>();
  const out = new Map<number, number>();
  for (const id of nodeIds) {
    const c = comm.get(id)!;
    if (!remap.has(c)) remap.set(c, remap.size);
    out.set(id, remap.get(c)!);
  }
  return out;
}
