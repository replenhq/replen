import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { computeOverlay } from "@/graph/overlay";
import { computeSemanticMap } from "@/graph/semantic-map";
import { AtlasGraph, type GNode, type GEdge } from "./AtlasGraph";

export const dynamic = "force-dynamic";

// Atlas webapp view — mission control for the portfolio. The force layout is
// the navigation; the dossier panel (server action) is the destination; the
// operational overlay (alerts / blind spots / queued work) is the live state;
// the semantic map view positions everything by MEANING (PCA over the same
// embeddings the matcher uses).
export default async function AtlasPage() {
  const user = await requireUser();
  const [rawNodes, rawEdges, overlay, mapPoints] = await Promise.all([
    db.select({ id: schema.graphNodes.id, kind: schema.graphNodes.kind, nodeKey: schema.graphNodes.nodeKey, label: schema.graphNodes.label, data: schema.graphNodes.data })
      .from(schema.graphNodes).where(eq(schema.graphNodes.userId, user.id)),
    db.select({ kind: schema.graphEdges.kind, srcId: schema.graphEdges.srcId, dstId: schema.graphEdges.dstId, weight: schema.graphEdges.weight })
      .from(schema.graphEdges).where(eq(schema.graphEdges.userId, user.id)),
    computeOverlay(user.id),
    computeSemanticMap(user.id),
  ]);

  const worstAlert = (alerts: Array<{ type: string; severity: string }> | undefined): string | null => {
    if (!alerts?.length) return null;
    if (alerts.some((a) => a.severity === "Critical" || a.type === "security")) return "security";
    if (alerts.some((a) => a.type === "breaking" || a.type === "deadline")) return "breaking";
    return "pricing";
  };

  const nodes: GNode[] = rawNodes.map((n) => {
    let d: Record<string, unknown> = {};
    try { d = n.data ? JSON.parse(n.data) : {}; } catch { /* */ }
    const o = overlay.get(`${n.kind} ${n.nodeKey}`);
    return {
      id: n.id, kind: n.kind, nodeKey: n.nodeKey, label: n.label,
      theme: (d.themeName as string) ?? null, keystone: !!d.keystone,
      provenance: (d.provenance as string) ?? null, stars: (d.stars as number) ?? null,
      degree: 0,
      alertKind: worstAlert(o?.alerts),
      alertCount: o?.alerts?.length ?? 0,
      blindspot: !!o?.blindspot,
      queued: o?.queued ?? 0,
    };
  });
  const edges: GEdge[] = rawEdges.map((e) => ({ kind: e.kind, src: e.srcId, dst: e.dstId, weight: e.weight }));
  const deg = new Map<number, number>();
  for (const e of edges) { deg.set(e.src, (deg.get(e.src) ?? 0) + 1); deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1); }
  for (const n of nodes) n.degree = deg.get(n.id) ?? 0;

  // Semantic-map coordinates keyed by node id (only kinds the map covers).
  const idByKindKey = new Map(nodes.map((n) => [`${n.kind} ${n.nodeKey}`, n.id]));
  const mapPos: Record<number, { x: number; y: number }> = {};
  for (const p of mapPoints) {
    const id = idByKindKey.get(`${p.kind} ${p.nodeKey}`);
    if (id != null) mapPos[id] = { x: p.x, y: p.y };
  }

  const alertTotal = nodes.reduce((s, n) => s + (n.alertCount > 0 ? 1 : 0), 0);
  const blindspots = nodes.filter((n) => n.blindspot).length;

  // Full-bleed: escape the global `main { max-width: 1100px }` container —
  // the graph owns every pixel below the nav.
  return (
    <main style={{ padding: 0, maxWidth: "none", width: "100vw", marginLeft: "calc(50% - 50vw)", height: "calc(100vh - 86px)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "12px 24px 10px", borderBottom: "1px solid var(--border, #262626)", flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, display: "inline" }}>Your Atlas</h1>
        <span style={{ marginLeft: 14, color: "var(--dim, #a3a3a3)", fontSize: 13 }}>
          {nodes.length} nodes · {edges.length} edges
          {alertTotal > 0 ? ` · ${alertTotal} node${alertTotal === 1 ? "" : "s"} with live alerts` : ""}
          {blindspots > 0 ? ` · ${blindspots} blind spot${blindspots === 1 ? "" : "s"}` : ""}
          {nodes.length === 0 ? " — run /replen-onboard and a pipeline run to build it." : ""}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {nodes.length > 0 ? <AtlasGraph nodes={nodes} edges={edges} mapPos={mapPos} /> : null}
      </div>
    </main>
  );
}
