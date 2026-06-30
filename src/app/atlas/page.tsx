import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { computeOverlay } from "@/graph/overlay";
import { computeSemanticMap } from "@/graph/semantic-map";
import { AtlasGraph, type GNode, type GEdge } from "./AtlasGraph";
import { suggestUpgrades } from "@/lib/keystone";
import { CartsView } from "./CartsView";
import { buildCartEngine, CARTS, type CartLayout } from "@/graph/carts";

export const dynamic = "force-dynamic";

// The Atlas sub-strip: title, Graph|Carts tabs, and the node/edge meta. Shared
// by both halves of Atlas (the graph = explore, Carts = browse + work).
function AtlasSubStrip({ view, nodes, edges, note }: { view: "graph" | "carts"; nodes: number; edges: number; note?: string }) {
  return (
    <div className="atlas-substrip">
      <h1>Atlas</h1>
      <nav className="atlas-tabs">
        <a href="/atlas" className={view === "graph" ? "active" : ""}>Graph</a>
        <a href="/atlas?view=carts" className={view === "carts" ? "active" : ""}>Carts</a>
      </nav>
      <span className="atlas-meta">{nodes} nodes&nbsp;·&nbsp;{edges} edges{note ?? ""}</span>
    </div>
  );
}

// Atlas webapp view — mission control for the portfolio. The force layout is
// the navigation; the dossier panel (server action) is the destination; the
// operational overlay (alerts / blind spots / queued work) is the live state;
// the semantic map view positions everything by MEANING (PCA over the same
// embeddings the matcher uses). Carts (?view=carts) is the database half.
export default async function AtlasPage({ searchParams }: { searchParams: Promise<{ node?: string; view?: string; cart?: string; layout?: string; q?: string; prov?: string; mod?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // Deep-link target ("tool:eslint") — footnote/Brief lines link here so
  // "where do I use this?" is one click. Resolved client-side by AtlasGraph.
  const focusNode = sp.node ?? null;

  // ---- Carts: the database half of Atlas (rail + table/board over the graph)
  if (sp.view === "carts") {
    const engine = await buildCartEngine(user.id);
    const activeId = sp.cart && CARTS.some((c) => c.id === sp.cart) ? sp.cart : CARTS[0].id;
    const layout = (["table", "board", "cards", "map", "timeline"].includes(sp.layout ?? "")
      ? sp.layout : CARTS.find((c) => c.id === activeId)?.layout) as CartLayout;
    return (
      <main className="atlas-main">
        <AtlasSubStrip view="carts" nodes={engine.nodeCount} edges={engine.edgeCount} />
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <CartsView engine={engine} activeId={activeId} layout={layout}
            filters={{ q: sp.q, provenance: sp.prov, modality: sp.mod }} />
        </div>
      </main>
    );
  }
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
      size: null, // filled below for project/product from repo file counts
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
      nodes.push({ id, kind, nodeKey: label, label, theme: null, waypoint: false, provenance: null, stars: null, degree: 0, alertKind: null, alertCount: 0, blindspot: false, queued: 0, size: null });
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
    const profs = await db.select({ slug: schema.projectProfiles.slug, summary: schema.projectProfiles.summaryJson, shape: schema.projectProfiles.shapeJson })
      .from(schema.projectProfiles).where(eq(schema.projectProfiles.userId, user.id));
    const tagToProject = new Map<string, string>();
    const allTags = new Set<string>();
    const fileCountBySlug = new Map<string, number>(); // repo size proxy → node radius
    for (const pr of profs) {
      if (pr.shape) {
        try { const ft = (JSON.parse(pr.shape) as { fileTree?: string[] }).fileTree;
          if (Array.isArray(ft) && ft.length > 0) fileCountBySlug.set(pr.slug, ft.length); } catch { /* */ }
      }
      if (!pr.summary) continue;
      try { const tags = (JSON.parse(pr.summary) as { capabilityTags?: string[] }).capabilityTags ?? [];
        for (const t of tags) { if (typeof t === "string") { allTags.add(t); if (!tagToProject.has(norm(t))) tagToProject.set(norm(t), pr.slug); } }
      } catch { /* */ }
    }
    // Size project nodes by their file count; size product nodes by the sum of
    // their member projects' file counts (a product groups projects via
    // MEMBER_OF). Leaves size null where the loader has no shape data yet.
    for (const n of nodes) if (n.kind === "project") n.size = fileCountBySlug.get(n.nodeKey) ?? null;
    const slugByNodeId = new Map(nodes.filter((n) => n.kind === "project").map((n) => [n.id, n.nodeKey]));
    const productSize = new Map<number, number>();
    for (const e of edges) if (e.kind === "MEMBER_OF") {
      const slug = slugByNodeId.get(e.src); const fc = slug ? fileCountBySlug.get(slug) : undefined;
      if (fc) productSize.set(e.dst, (productSize.get(e.dst) ?? 0) + fc);
    }
    for (const n of nodes) if (n.kind === "product") n.size = productSize.get(n.id) ?? null;

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
  const note =
    (alertTotal > 0 ? ` · ${alertTotal} node${alertTotal === 1 ? "" : "s"} with live alerts` : "") +
    (blindspots > 0 ? ` · ${blindspots} blind spot${blindspots === 1 ? "" : "s"}` : "") +
    (nodes.length === 0 ? " · run /replen-onboard and a pipeline run to build it." : "");

  // Full-bleed: escape the global `main { max-width: 1100px }` container —
  // the graph owns every pixel below the nav.
  return (
    <main className="atlas-main">
      <AtlasSubStrip view="graph" nodes={nodes.length} edges={edges.length} note={note} />
      <div style={{ flex: 1, minHeight: 0 }}>
        {nodes.length > 0 ? <AtlasGraph nodes={nodes} edges={edges} mapPos={mapPos} initialFocus={focusNode ?? null} /> : null}
      </div>
    </main>
  );
}
