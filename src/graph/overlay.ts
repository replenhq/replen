// Operational overlay — the live state projected onto the graph's structure.
// This is what turns the Atlas view from eye candy into mission control: tool
// nodes carry this fortnight's awareness events (pricing / security /
// deadlines), capability nodes know whether anything has ever filled them,
// and project nodes carry their queued work. Computed server-side from the
// same tables that feed the footnote; the webapp only renders.

import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client";

export type NodeOverlay = {
  // tool nodes: awareness events anchored to this tool in the window
  alerts?: Array<{ type: "security" | "pricing" | "deadline" | "breaking" | "other"; severity: string; title: string }>;
  // capability nodes: nothing has ever been evaluated against this
  blindspot?: boolean;
  // project nodes: pending queued work
  queued?: number;
  // tool nodes: versions reported per project ("acme: 3.10.12")
  versions?: string[];
};

const WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_OVERLAY_WINDOW_DAYS ?? "14", 10) || 14);

const alertType = (eventType: string): "security" | "pricing" | "breaking" | "other" => {
  if (/security|exploit|breach|malware|secret|cve/.test(eventType)) return "security";
  if (/pricing|license/.test(eventType)) return "pricing";
  if (/breaking|deprecat|outage/.test(eventType)) return "breaking";
  return "other";
};

// nodeKey-keyed overlays: `tool <name>` / `capability <key>` / `project <slug>`.
export async function computeOverlay(userId: number): Promise<Map<string, NodeOverlay>> {
  const out = new Map<string, NodeOverlay>();
  const since = new Date(Date.now() - WINDOW_DAYS * 86400e3);
  const get = (key: string): NodeOverlay => { const o = out.get(key) ?? {}; out.set(key, o); return o; };

  // Tool nodes + USES versions come from the graph itself.
  const nodes = await db.select({ id: schema.graphNodes.id, kind: schema.graphNodes.kind, nodeKey: schema.graphNodes.nodeKey })
    .from(schema.graphNodes).where(eq(schema.graphNodes.userId, userId));
  const edges = await db.select({ kind: schema.graphEdges.kind, srcId: schema.graphEdges.srcId, dstId: schema.graphEdges.dstId, data: schema.graphEdges.data })
    .from(schema.graphEdges).where(eq(schema.graphEdges.userId, userId));
  const toolKeys = new Set<string>();
  const projectById = new Map<number, string>();
  const toolById = new Map<number, string>();
  for (const n of nodes) {
    if (n.kind === "tool") { toolKeys.add(n.nodeKey); toolById.set(n.id, n.nodeKey); }
    if (n.kind === "project") projectById.set(n.id, n.nodeKey);
  }
  const filledCaps = new Set<number>();
  for (const e of edges) {
    if (e.kind === "FILLS") filledCaps.add(e.dstId);
    if (e.kind === "USES") {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        if (d.version) {
          const tool = toolById.get(e.dstId);
          const proj = projectById.get(e.srcId);
          if (tool && proj) {
            const o = get(`tool ${tool}`);
            (o.versions ?? (o.versions = [])).push(`${proj}: ${d.version}`);
          }
        }
      } catch { /* */ }
    }
  }
  for (const n of nodes) {
    if (n.kind === "capability" && !filledCaps.has(n.id)) get(`capability ${n.nodeKey}`).blindspot = true;
  }

  const matchTools = (detectTokens: string | null): string[] => {
    try {
      const toks: string[] = JSON.parse(detectTokens ?? "[]");
      return toks.filter((t) => toolKeys.has(t));
    } catch { return []; }
  };

  // Classified events of the window → tool alerts.
  const events = await db
    .select({
      eventType: schema.classifiedEvents.eventType, severity: schema.classifiedEvents.severity,
      title: schema.classifiedEvents.title, detectTokens: schema.announcementSources.detectTokens,
    })
    .from(schema.classifiedEvents)
    .innerJoin(schema.announcementSources, eq(schema.classifiedEvents.sourcePk, schema.announcementSources.id))
    .where(gte(schema.classifiedEvents.detectedAt, since));
  for (const ev of events) {
    for (const tool of matchTools(ev.detectTokens)) {
      const o = get(`tool ${tool}`);
      (o.alerts ?? (o.alerts = [])).push({ type: alertType(ev.eventType), severity: ev.severity, title: ev.title.slice(0, 120) });
    }
  }

  // Pricing changes of the window.
  const prices = await db
    .select({ summary: schema.pricingChanges.summary, detectTokens: schema.pricingTools.detectTokens })
    .from(schema.pricingChanges)
    .innerJoin(schema.pricingTools, eq(schema.pricingChanges.toolId, schema.pricingTools.id))
    .where(gte(schema.pricingChanges.detectedAt, since));
  for (const pc of prices) {
    for (const tool of matchTools(pc.detectTokens)) {
      const o = get(`tool ${tool}`);
      (o.alerts ?? (o.alerts = [])).push({ type: "pricing", severity: "Medium", title: pc.summary.slice(0, 120) });
    }
  }

  // Upcoming/recent deadlines.
  const deadlines = await db.select().from(schema.deadlineEvents)
    .where(gte(schema.deadlineEvents.deadline, new Date(Date.now() - 30 * 86400e3)));
  for (const d of deadlines) {
    if (d.deadline.getTime() > Date.now() + 60 * 86400e3) continue;
    for (const tool of matchTools(d.detectTokens)) {
      const o = get(`tool ${tool}`);
      const days = Math.round((d.deadline.getTime() - Date.now()) / 86400e3);
      (o.alerts ?? (o.alerts = [])).push({
        type: "deadline", severity: days <= 7 ? "High" : "Medium",
        title: `${d.title} — ${days < 0 ? "EOL passed" : `EOL in ${days}d`}`,
      });
    }
  }

  // Queued work per project.
  const queued = await db.select({ projectSlug: schema.queuedActions.projectSlug })
    .from(schema.queuedActions)
    .where(and(eq(schema.queuedActions.userId, userId), eq(schema.queuedActions.status, "queued")));
  for (const q of queued) {
    if (!q.projectSlug) continue;
    const o = get(`project ${q.projectSlug}`);
    o.queued = (o.queued ?? 0) + 1;
  }

  return out;
}
