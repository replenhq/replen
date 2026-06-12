import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { computeOverlay } from "@/graph/overlay";
import { computeSemanticMap } from "@/graph/semantic-map";
import { AtlasGraph, type GNode, type GEdge } from "./AtlasGraph";
import { suggestUpgrades } from "@/lib/keystone";

export const dynamic = "force-dynamic";

// Atlas webapp view — mission control for the portfolio. The force layout is
// the navigation; the dossier panel (server action) is the destination; the
// operational overlay (alerts / blind spots / queued work) is the live state;
// the semantic map view positions everything by MEANING (PCA over the same
// embeddings the matcher uses).
export default async function AtlasPage({ searchParams }: { searchParams: Promise<{ node?: string }> }) {
  const user = await requireUser();
  // Deep-link target ("tool:eslint") — footnote/Brief lines link here so
  // "where do I use this?" is one click. Resolved client-side by AtlasGraph.
  const { node: focusNode } = await searchParams;
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
      theme: (d.themeName as string) ?? null, waypoint: !!d.waypoint,
      provenance: (d.provenance as string) ?? null, stars: (d.stars as number) ?? null,
      degree: 0,
      alertKind: worstAlert(o?.alerts),
      alertCount: o?.alerts?.length ?? 0,
      blindspot: !!o?.blindspot,
      queued: o?.queued ?? 0,
    };
  });
  const edges: GEdge[] = rawEdges.map((e) => ({ kind: e.kind, src: e.srcId, dst: e.dstId, weight: e.weight }));

  // Keystone overlay — render the comparative layer ON the map: a tool /
  // capability / algorithm you use that has a `better_than` edge gets a gold
  // BETTER_THAN edge to a recommended-alternative node. The judgment layer made
  // visible (footnotes already say it in-session; this shows it spatially).
  // Render-time injection — touches neither the graph build nor the renderer's
  // data, only augments what's drawn. Synthetic nodes use negative ids.
  try {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let synth = -1;
    const mkNode = (kind: string, label: string): number => {
      const id = synth--;
      nodes.push({ id, kind, nodeKey: label, label, theme: null, waypoint: false, provenance: null, stars: null, degree: 0, alertKind: null, alertCount: 0, blindspot: false, queued: 0 });
      return id;
    };
    // Existing graph nodes that can carry an upgrade (tools + facet capabilities).
    const idByName = new Map<string, number>();
    for (const n of nodes.filter((n) => n.kind === "tool" || n.kind === "capability")) { idByName.set(norm(n.nodeKey), n.id); idByName.set(norm(n.label), n.id); }
    // ALGORITHMS live in capabilityTags, not the facet-built graph nodes — pull
    // them per project so algorithm upgrades render too. Map a tag → the project
    // node that has it (so a synthetic capability node can attach to its project).
    const projNodeId = new Map<string, number>();
    for (const n of nodes.filter((n) => n.kind === "project")) projNodeId.set(n.nodeKey, n.id);
    const profs = await db.select({ slug: schema.projectProfiles.slug, summary: schema.projectProfiles.summaryJson })
      .from(schema.projectProfiles).where(eq(schema.projectProfiles.userId, user.id));
    const tagToProject = new Map<string, string>();
    const allTags = new Set<string>();
    for (const pr of profs) {
      if (!pr.summary) continue;
      try { const tags = (JSON.parse(pr.summary) as { capabilityTags?: string[] }).capabilityTags ?? [];
        for (const t of tags) { if (typeof t === "string") { allTags.add(t); if (!tagToProject.has(norm(t))) tagToProject.set(norm(t), pr.slug); } }
      } catch { /* */ }
    }

    const probeNames = [...idByName.keys(), ...allTags];
    const ups = await suggestUpgrades(probeNames);
    const betterNodeId = new Map<string, number>(); // dedup recommended nodes
    const synthCapId = new Map<string, number>();    // dedup synthetic capability nodes
    for (const u of ups) {
      const cur = norm(u.current);
      // Source: an existing tool/capability node, else a synthetic capability
      // node for the algorithm tag (linked to the project that has it).
      let srcId = idByName.get(cur);
      if (srcId == null) {
        const slug = tagToProject.get(cur);
        const pid = slug ? projNodeId.get(slug) : undefined;
        if (pid == null) continue;
        srcId = synthCapId.get(cur);
        if (srcId == null) { srcId = mkNode("capability", u.current); synthCapId.set(cur, srcId); edges.push({ kind: "HAS_CAPABILITY", src: pid, dst: srcId, weight: null }); }
      }
      const key = norm(u.better);
      let dstId = betterNodeId.get(key);
      if (dstId == null) { dstId = mkNode("upgrade", u.better); betterNodeId.set(key, dstId); }
      edges.push({ kind: "BETTER_THAN", src: srcId, dst: dstId, weight: null });
    }
  } catch { /* overlay is best-effort; never break the graph */ }

  const deg = new Map<number, number>();
  for (const e of edges) { deg.set(e.src, (deg.get(e.src) ?? 0) + 1); deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1); }
  for (const n of nodes) n.degree = deg.get(n.id) ?? 0;

  // Semantic-map coordinates keyed by node id (only kinds the map covers).
  // z is the third principal component — the 3D view's depth axis.
  const idByKindKey = new Map(nodes.map((n) => [`${n.kind} ${n.nodeKey}`, n.id]));
  const mapPos: Record<number, { x: number; y: number; z: number }> = {};
  for (const p of mapPoints) {
    const id = idByKindKey.get(`${p.kind} ${p.nodeKey}`);
    if (id != null) mapPos[id] = { x: p.x, y: p.y, z: p.z };
  }

  const alertTotal = nodes.reduce((s, n) => s + (n.alertCount > 0 ? 1 : 0), 0);
  const blindspots = nodes.filter((n) => n.blindspot).length;

  // Full-bleed: escape the global `main { max-width: 1100px }` container —
  // the graph owns every pixel below the nav.
  return (
    <main style={{ padding: 0, maxWidth: "none", width: "100vw", marginLeft: "calc(50% - 50vw)", height: "calc(100vh - 86px)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "12px 24px 10px", borderBottom: "1px solid var(--border, #262626)", flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, display: "inline" }}>Atlas</h1>
        <span style={{ marginLeft: 14, color: "var(--dim, #a3a3a3)", fontSize: 13 }}>
          {nodes.length} nodes · {edges.length} edges
          {alertTotal > 0 ? ` · ${alertTotal} node${alertTotal === 1 ? "" : "s"} with live alerts` : ""}
          {blindspots > 0 ? ` · ${blindspots} blind spot${blindspots === 1 ? "" : "s"}` : ""}
          {nodes.length === 0 ? " — run /replen-onboard and a pipeline run to build it." : ""}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {nodes.length > 0 ? <AtlasGraph nodes={nodes} edges={edges} mapPos={mapPos} initialFocus={focusNode ?? null} /> : null}
      </div>
    </main>
  );
}
