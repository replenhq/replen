import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { AtlasGraph, type GNode, type GEdge } from "./AtlasGraph";

export const dynamic = "force-dynamic";

// Atlas webapp view — the interactive, zero-install, always-live graph of the
// user's dev world. Distinct from the Obsidian export (owned/offline/extensible)
// and from the MCP tools (in-session): this is the shareable, clickable surface.
export default async function AtlasPage() {
  const user = await requireUser();
  const [rawNodes, rawEdges] = await Promise.all([
    db.select({ id: schema.graphNodes.id, kind: schema.graphNodes.kind, label: schema.graphNodes.label, data: schema.graphNodes.data })
      .from(schema.graphNodes).where(eq(schema.graphNodes.userId, user.id)),
    db.select({ kind: schema.graphEdges.kind, srcId: schema.graphEdges.srcId, dstId: schema.graphEdges.dstId, weight: schema.graphEdges.weight })
      .from(schema.graphEdges).where(eq(schema.graphEdges.userId, user.id)),
  ]);

  const nodes: GNode[] = rawNodes.map((n) => {
    let d: Record<string, unknown> = {};
    try { d = n.data ? JSON.parse(n.data) : {}; } catch { /* */ }
    return {
      id: n.id, kind: n.kind, label: n.label,
      theme: (d.themeName as string) ?? null, keystone: !!d.keystone,
      provenance: (d.provenance as string) ?? null, stars: (d.stars as number) ?? null,
      degree: 0,
    };
  });
  const edges: GEdge[] = rawEdges.map((e) => ({ kind: e.kind, src: e.srcId, dst: e.dstId, weight: e.weight }));
  // degree for sizing
  const deg = new Map<number, number>();
  for (const e of edges) { deg.set(e.src, (deg.get(e.src) ?? 0) + 1); deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1); }
  for (const n of nodes) n.degree = deg.get(n.id) ?? 0;

  return (
    <main style={{ padding: "0", height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border, #262626)" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Your Atlas</h1>
        <p style={{ margin: "4px 0 0", color: "var(--dim, #a3a3a3)", fontSize: 14 }}>
          {nodes.length} nodes · {edges.length} edges. Drag to pan, scroll to zoom, click a node to focus.
          {nodes.length === 0 ? " — run /replen-onboard and a pipeline run to build it." : ""}
        </p>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {nodes.length > 0 ? <AtlasGraph nodes={nodes} edges={edges} /> : null}
      </div>
    </main>
  );
}
