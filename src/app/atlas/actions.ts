"use server";

// Atlas dossier + actions. Clicking a node opens the full picture (the same
// depth the vault notes carry) and lets the user act — the graph is the
// navigation, the dossier is the destination.

import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { alternativesFor } from "@/lib/alternatives";
import { computeOverlay } from "@/graph/overlay";

export type Dossier = {
  kind: string;
  title: string;
  subtitle?: string | null;
  sections: Array<{ heading: string; items: string[] }>;
  url?: string | null;
  blindspot?: boolean;
  queueSuggestion?: string | null; // prefilled title for the queue button
};

const j = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
};

export async function getNodeDossier(kind: string, nodeKey: string): Promise<Dossier | null> {
  const user = await requireUser();
  const node = await db.select().from(schema.graphNodes)
    .where(and(eq(schema.graphNodes.userId, user.id), eq(schema.graphNodes.kind, kind), eq(schema.graphNodes.nodeKey, nodeKey))).get();
  if (!node) return null;
  const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.userId, user.id));
  const edges = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.userId, user.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const data = j(node.data);

  if (kind === "project") {
    const caps: string[] = [];
    const decisions: string[] = [];
    const tools: string[] = [];
    for (const e of edges) {
      if (e.srcId !== node.id) continue;
      const dst = byId.get(e.dstId);
      if (!dst) continue;
      const ed = j(e.data);
      if (e.kind === "HAS_CAPABILITY") caps.push(`${dst.label} · ${ed.provenance ?? "inferred"}`);
      if (e.kind === "EVALUATED") decisions.push(`${ed.verdict} — ${dst.label}${ed.reasonCode ? ` (${ed.reasonCode})` : ""}${ed.oneLine ? `: ${ed.oneLine}` : ""}${ed.at ? ` · ${fmtDate(String(ed.at))}` : ""}`);
      if (e.kind === "USES") tools.push(`${dst.label}${ed.version ? `@${ed.version}` : ""}`);
    }
    const profile = await db.select({ summaryJson: schema.projectProfiles.summaryJson, githubFullName: schema.projectProfiles.githubFullName })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.slug, nodeKey))).get();
    const purpose = (j(profile?.summaryJson ?? null).purpose as string) ?? null;
    const queued = await db.select({ title: schema.queuedActions.title }).from(schema.queuedActions)
      .where(and(eq(schema.queuedActions.userId, user.id), eq(schema.queuedActions.status, "queued"), eq(schema.queuedActions.projectSlug, nodeKey)));
    const sections: Dossier["sections"] = [];
    if (caps.length) sections.push({ heading: `Capabilities (${caps.length})`, items: caps.sort() });
    if (tools.length) sections.push({ heading: `Uses (${tools.length})`, items: tools.sort().slice(0, 40) });
    if (decisions.length) sections.push({ heading: `Decisions (${decisions.length})`, items: decisions });
    if (queued.length) sections.push({ heading: "Queued work", items: queued.map((q) => q.title) });
    return {
      kind, title: node.label, subtitle: purpose,
      url: profile?.githubFullName ? `https://github.com/${profile.githubFullName}` : null,
      sections,
    };
  }

  if (kind === "capability") {
    const usedIn: string[] = [];
    const adjacent: string[] = [];
    const fills: string[] = [];
    for (const e of edges) {
      if (e.kind === "HAS_CAPABILITY" && e.dstId === node.id) {
        const src = byId.get(e.srcId);
        if (src) usedIn.push(`${src.label} · ${j(e.data).provenance ?? "inferred"}`);
      }
      if (e.kind === "ADJACENT_TO" && (e.srcId === node.id || e.dstId === node.id)) {
        const other = byId.get(e.srcId === node.id ? e.dstId : e.srcId);
        if (other) adjacent.push(`${other.label}${e.weight != null ? ` (${e.weight.toFixed(2)})` : ""}`);
      }
      if (e.kind === "FILLS" && e.dstId === node.id) {
        const cand = byId.get(e.srcId);
        if (cand) fills.push(cand.label);
      }
    }
    const blindspot = fills.length === 0;
    const sections: Dossier["sections"] = [];
    if (usedIn.length) sections.push({ heading: `Used in (${usedIn.length})`, items: usedIn.sort() });
    if (fills.length) sections.push({ heading: "Filled by", items: fills });
    else sections.push({ heading: "Coverage", items: ["Blind spot — nothing has ever been evaluated against this capability. Blind-spot scouting searches it on the next pipeline run."] });
    if (adjacent.length) sections.push({ heading: "Adjacent capabilities", items: adjacent.slice(0, 8) });
    const mods = Array.isArray(data.modality) ? (data.modality as string[]) : [];
    const aliases = Array.isArray(data.aliases) ? (data.aliases as string[]) : [];
    if (aliases.length) sections.push({ heading: "Also known as", items: aliases });
    return {
      kind, title: node.label,
      subtitle: [data.themeName ? `theme: ${data.themeName}` : null, data.keystone ? "keystone" : null, mods.length ? `modality: ${mods.join(", ")}` : null].filter(Boolean).join(" · ") || null,
      sections, blindspot,
      queueSuggestion: blindspot ? `Find a library for "${node.label}" (coverage blind spot)` : null,
    };
  }

  if (kind === "candidate") {
    const fullName = String(data.fullName ?? node.label);
    const verdicts: string[] = [];
    const fillsC: string[] = [];
    for (const e of edges) {
      if (e.kind === "EVALUATED" && e.dstId === node.id) {
        const proj = byId.get(e.srcId);
        const ed = j(e.data);
        if (proj) verdicts.push(`${ed.verdict} for ${proj.label}${ed.reasonCode ? ` (${ed.reasonCode})` : ""}${ed.oneLine ? `: ${ed.oneLine}` : ""}${ed.at ? ` · ${fmtDate(String(ed.at))}` : ""}`);
      }
      if (e.kind === "FILLS" && e.srcId === node.id) {
        const cap = byId.get(e.dstId);
        if (cap) fillsC.push(cap.label);
      }
    }
    const alts = await alternativesFor(fullName, 3).catch(() => []);
    const sections: Dossier["sections"] = [];
    if (fillsC.length) sections.push({ heading: "Fills", items: fillsC });
    if (verdicts.length) sections.push({ heading: "Your decisions", items: verdicts });
    if (alts.length) sections.push({ heading: "Similar maintained libraries", items: alts.map((a) => `${a.fullName}${a.stars ? ` · ${a.stars}★` : ""}${a.adoptedBy ? ` · adopted by ${a.adoptedBy}` : ""}`) });
    return {
      kind, title: fullName,
      subtitle: data.stars != null ? `${data.stars}★` : null,
      url: (data.url as string) ?? `https://github.com/${fullName}`,
      sections,
    };
  }

  if (kind === "tool") {
    const usedBy: string[] = [];
    for (const e of edges) {
      if (e.kind === "USES" && e.dstId === node.id) {
        const proj = byId.get(e.srcId);
        const v = j(e.data).version;
        if (proj) usedBy.push(`${proj.label}${v ? ` @ ${v}` : ""}`);
      }
    }
    const overlay = await computeOverlay(user.id);
    const o = overlay.get(`tool ${node.nodeKey}`);
    const sections: Dossier["sections"] = [];
    if (usedBy.length) sections.push({ heading: `Used by (${usedBy.length})`, items: usedBy.sort() });
    if (o?.alerts?.length) sections.push({ heading: "Last 14 days", items: o.alerts.map((a) => `[${a.type}/${a.severity}] ${a.title}`) });
    return {
      kind, title: node.label, subtitle: "external tool / dependency",
      sections,
      queueSuggestion: o?.alerts?.length ? `Review ${node.label}: ${o.alerts[0].title.slice(0, 80)}` : null,
    };
  }

  if (kind === "product") {
    const members: string[] = [];
    for (const e of edges) {
      if (e.kind === "MEMBER_OF" && e.dstId === node.id) {
        const proj = byId.get(e.srcId);
        if (proj) members.push(proj.label);
      }
    }
    return { kind, title: node.label, subtitle: "multi-repo product", sections: [{ heading: "Repos", items: members.sort() }] };
  }

  return { kind, title: node.label, sections: [] };
}

export async function queueFromAtlas(title: string, projectSlug?: string | null): Promise<{ ok: boolean; id?: number }> {
  const user = await requireUser();
  const clean = title.trim().slice(0, 140);
  if (!clean) return { ok: false };
  const inserted = await db.insert(schema.queuedActions).values({
    userId: user.id, kind: "custom", refId: null, title: clean,
    note: "queued from the Atlas view", projectSlug: projectSlug ?? null,
    status: "queued", createdAt: new Date(),
  }).returning({ id: schema.queuedActions.id }).get();
  return { ok: true, id: inserted?.id };
}
