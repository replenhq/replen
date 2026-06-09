// Build + inspect a user's Atlas graph.
//   tsx src/cli/build-graph.ts --user 1            build (skip if unchanged)
//   tsx src/cli/build-graph.ts --user 1 --force    rebuild
//   tsx src/cli/build-graph.ts --user 1 --inspect  print node/edge summary + samples

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { buildUserGraph } from "../graph/build";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function inspect(userId: number) {
  const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.userId, userId));
  const edges = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.userId, userId));
  const byKind = (rows: { kind: string }[]) => Object.entries(rows.reduce<Record<string, number>>((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
  console.log(`\nAtlas graph for user ${userId}\n${"=".repeat(44)}`);
  console.log(`Nodes (${nodes.length}): ${byKind(nodes).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  console.log(`Edges (${edges.length}): ${byKind(edges).map(([k, n]) => `${k} ${n}`).join(" · ")}`);

  const idToNode = new Map(nodes.map((n) => [n.id, n]));
  // Sample: which projects share a capability (HAS_CAPABILITY fan-in > 1)
  const capFanIn = new Map<number, string[]>();
  for (const e of edges.filter((e) => e.kind === "HAS_CAPABILITY")) {
    const arr = capFanIn.get(e.dstId) ?? []; arr.push(idToNode.get(e.srcId)?.label ?? "?"); capFanIn.set(e.dstId, arr);
  }
  const shared = [...capFanIn.entries()].filter(([, ps]) => ps.length > 1).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  if (shared.length) {
    console.log(`\nKeystone capabilities (shared across projects):`);
    for (const [capId, ps] of shared) console.log(`  ${idToNode.get(capId)?.label.padEnd(28)} ← ${ps.join(", ")}`);
  }
  // Sample: a few ADJACENT_TO leaps
  const adj = edges.filter((e) => e.kind === "ADJACENT_TO").sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, 6);
  if (adj.length) {
    console.log(`\nAdjacency (related-but-distinct capabilities):`);
    for (const e of adj) console.log(`  ${idToNode.get(e.srcId)?.label} ↔ ${idToNode.get(e.dstId)?.label}  (${(e.weight ?? 0).toFixed(2)})`);
  }
  // Sample: RELATES_TO
  const rel = edges.filter((e) => e.kind === "RELATES_TO").slice(0, 6);
  if (rel.length) {
    console.log(`\nRelated projects:`);
    for (const e of rel) { let d: { sharedCaps?: string[] } = {}; try { d = JSON.parse(e.data ?? "{}"); } catch { /* */ } console.log(`  ${idToNode.get(e.srcId)?.label} ↔ ${idToNode.get(e.dstId)?.label}  shared: ${(d.sharedCaps ?? []).join(", ") || "—"}`); }
  }
  console.log("");
}

async function main() {
  const userId = parseInt(arg("user", "1") ?? "1", 10);
  if (!has("inspect")) {
    const r = await buildUserGraph(userId, { force: has("force") });
    console.log(`[graph] user ${userId}: ${r.built ? "built" : "unchanged"} (${r.reason}) — ${r.nodeCount} nodes, ${r.edgeCount} edges`);
  }
  await inspect(userId);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
