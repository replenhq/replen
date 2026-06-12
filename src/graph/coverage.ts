// Coverage — which capabilities discovery has never delivered for. A
// capability node with no FILLS edge has never had a candidate evaluated
// against it; when it's also a WAYPOINT (connects much of the portfolio),
// that's the costliest kind of blind spot. The Atlas MAP lists these for
// humans; this module feeds them back into acquisition (the targeted search
// fetcher scouts them directly).

import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client";

export type BlindSpot = { label: string; projectSlugs: string[]; degree: number };

export async function uncoveredWaypoints(userId: number, limit = 3): Promise<BlindSpot[]> {
  const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.userId, userId));
  const edges = await db.select({ kind: schema.graphEdges.kind, srcId: schema.graphEdges.srcId, dstId: schema.graphEdges.dstId })
    .from(schema.graphEdges).where(and(eq(schema.graphEdges.userId, userId)));
  if (!nodes.length) return [];

  const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  const projects = new Map<number, string>(); // nodeId → slug
  const waypoints = new Map<number, { label: string; degree: number }>();
  for (const n of nodes) {
    if (n.kind === "project") projects.set(n.id, n.nodeKey);
    if (n.kind === "capability") {
      const data = parse(n.data);
      if (data.waypoint) waypoints.set(n.id, { label: n.label, degree: Number(data.degree ?? 0) });
    }
  }
  if (!waypoints.size) return [];

  const filled = new Set<number>();
  const capProjects = new Map<number, string[]>();
  for (const e of edges) {
    if (e.kind === "FILLS") filled.add(e.dstId);
    if (e.kind === "HAS_CAPABILITY" && waypoints.has(e.dstId)) {
      const slug = projects.get(e.srcId);
      if (slug) (capProjects.get(e.dstId) ?? capProjects.set(e.dstId, []).get(e.dstId)!).push(slug);
    }
  }

  return [...waypoints.entries()]
    .filter(([id]) => !filled.has(id) && (capProjects.get(id)?.length ?? 0) > 0)
    .map(([id, k]) => ({ label: k.label, degree: k.degree, projectSlugs: capProjects.get(id)! }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);
}

// ── ranking hints — the graph's contribution to the daily matcher ───────────
// waypointLabels: capabilities that connect much of the portfolio (filling one
//   is leverage). unfilledLabels: capabilities discovery never delivered for
//   (filling one is exploration). relatedSlugs: projects RELATES_TO the scoped
//   one (their adoptions are a prior — fed into the taste vector).
export type RankHints = { waypointLabels: Set<string>; unfilledLabels: Set<string>; relatedSlugs: string[] };

const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export async function loadRankHints(userId: number, scopedSlug: string | null): Promise<RankHints> {
  const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.userId, userId));
  const edges = await db.select({ kind: schema.graphEdges.kind, srcId: schema.graphEdges.srcId, dstId: schema.graphEdges.dstId, weight: schema.graphEdges.weight })
    .from(schema.graphEdges).where(eq(schema.graphEdges.userId, userId));
  const hints: RankHints = { waypointLabels: new Set(), unfilledLabels: new Set(), relatedSlugs: [] };
  if (!nodes.length) return hints;

  const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  const filled = new Set<number>();
  for (const e of edges) if (e.kind === "FILLS") filled.add(e.dstId);

  const projectIdBySlug = new Map<string, number>();
  const slugById = new Map<number, string>();
  for (const n of nodes) {
    if (n.kind === "project") { projectIdBySlug.set(n.nodeKey, n.id); slugById.set(n.id, n.nodeKey); }
    if (n.kind === "capability") {
      const d = parse(n.data);
      const key = normLabel(n.label);
      if (d.waypoint) hints.waypointLabels.add(key);
      if (!filled.has(n.id)) hints.unfilledLabels.add(key);
    }
  }
  if (scopedSlug) {
    const scopedId = projectIdBySlug.get(scopedSlug);
    if (scopedId != null) {
      for (const e of edges) {
        if (e.kind !== "RELATES_TO") continue;
        if (e.srcId === scopedId) { const s = slugById.get(e.dstId); if (s) hints.relatedSlugs.push(s); }
        else if (e.dstId === scopedId) { const s = slugById.get(e.srcId); if (s) hints.relatedSlugs.push(s); }
      }
    }
  }
  return hints;
}
