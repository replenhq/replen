// Atlas §4 — render the user's knowledge graph as an owned, local, navigable
// markdown vault with [[backlinks]] (Obsidian-compatible). One source of truth
// here (server-side); the `replen atlas` CLI writes the files to the user's
// ~/.replen/atlas/. Opening it in Obsidian gives the graph view of their code +
// the ecosystem + their decisions for free.

import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client";

export type AtlasFile = { path: string; content: string };

const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled";
const capFile = (label: string) => `capabilities/${fileSlug(label)}`;
const candFile = (fullName: string) => `candidates/${fileSlug(fullName)}`;
const projFile = (slug: string) => `projects/${fileSlug(slug)}`;
const themeFile = (name: string) => `themes/${fileSlug(name)}`;
const link = (target: string, display?: string) => display ? `[[${target}|${display}]]` : `[[${target}]]`;

type GNode = { id: number; kind: string; nodeKey: string; label: string; data: Record<string, unknown> };
const j = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export async function renderAtlas(userId: number): Promise<AtlasFile[]> {
  const rawNodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.userId, userId));
  const rawEdges = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.userId, userId));
  if (!rawNodes.length) return [];
  const nodes: GNode[] = rawNodes.map((n) => ({ id: n.id, kind: n.kind, nodeKey: n.nodeKey, label: n.label, data: j(n.data) }));
  const edges = rawEdges.map((e) => ({ kind: e.kind, srcId: e.srcId, dstId: e.dstId, weight: e.weight, data: j(e.data) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const labelOf = (id: number) => byId.get(id)?.label ?? "?";

  const projects = nodes.filter((n) => n.kind === "project");
  const caps = nodes.filter((n) => n.kind === "capability");
  const cands = nodes.filter((n) => n.kind === "candidate");

  // index edges
  const projCaps = new Map<number, Array<{ cap: GNode; provenance: string }>>();
  const capProjs = new Map<number, GNode[]>();
  const adj = new Map<number, Array<{ cap: GNode; w: number }>>();
  const evaluated = new Map<number, Array<{ cand: GNode; verdict: string; reasonCode: string; oneLine: string }>>(); // projId → decisions
  const candDecisions = new Map<number, Array<{ proj: GNode; verdict: string; reasonCode: string; oneLine: string }>>();
  const candFills = new Map<number, GNode[]>();
  const projProduct = new Map<number, GNode>();
  for (const e of edges) {
    const s = byId.get(e.srcId), d = byId.get(e.dstId); if (!s || !d) continue;
    if (e.kind === "HAS_CAPABILITY") { (projCaps.get(s.id) ?? projCaps.set(s.id, []).get(s.id)!).push({ cap: d, provenance: String(e.data.provenance ?? "inferred") }); (capProjs.get(d.id) ?? capProjs.set(d.id, []).get(d.id)!).push(s); }
    if (e.kind === "ADJACENT_TO") { (adj.get(e.srcId) ?? adj.set(e.srcId, []).get(e.srcId)!).push({ cap: d, w: e.weight ?? 0 }); (adj.get(e.dstId) ?? adj.set(e.dstId, []).get(e.dstId)!).push({ cap: s, w: e.weight ?? 0 }); }
    if (e.kind === "EVALUATED") { const rec = { verdict: String(e.data.verdict ?? ""), reasonCode: String(e.data.reasonCode ?? ""), oneLine: String(e.data.oneLine ?? "") }; (evaluated.get(s.id) ?? evaluated.set(s.id, []).get(s.id)!).push({ cand: d, ...rec }); (candDecisions.get(d.id) ?? candDecisions.set(d.id, []).get(d.id)!).push({ proj: s, ...rec }); }
    if (e.kind === "FILLS") { (candFills.get(s.id) ?? candFills.set(s.id, []).get(s.id)!).push(d); }
    if (e.kind === "MEMBER_OF") { projProduct.set(s.id, d); }
  }

  const reports = new Map<string, { report: string | null; purpose: string | null }>();
  const rows = await db.select({ slug: schema.projectProfiles.slug, agentReport: schema.projectProfiles.agentReport, summaryJson: schema.projectProfiles.summaryJson })
    .from(schema.projectProfiles).where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true)));
  for (const r of rows) { let purpose: string | null = null; try { purpose = (JSON.parse(r.summaryJson ?? "{}") as { purpose?: string }).purpose ?? null; } catch { /* */ } reports.set(r.slug, { report: r.agentReport, purpose }); }

  const files: AtlasFile[] = [];

  // themes index
  const themeMembers = new Map<string, GNode[]>();
  for (const c of caps) { const t = String(c.data.themeName ?? ""); if (!t) continue; (themeMembers.get(t) ?? themeMembers.set(t, []).get(t)!).push(c); }
  const keystones = caps.filter((c) => c.data.keystone).sort((a, b) => (Number(b.data.degree ?? 0)) - (Number(a.data.degree ?? 0)));

  // MAP.md
  files.push({ path: "MAP.md", content: [
    `# Your Replen Atlas`, ``,
    `A map of your projects, what they do, the ecosystem around them, and every decision you've made. Open this folder in Obsidian for the graph view.`, ``,
    `## Keystone capabilities`, `The capabilities that connect the most of your work.`, ``,
    ...keystones.slice(0, 12).map((c) => `- ${link(capFile(c.label), c.label)} — ${capProjs.get(c.id)?.length ?? 0} projects`), ``,
    `## Themes`, ...[...themeMembers.entries()].filter(([, m]) => m.length >= 3).sort((a, b) => b[1].length - a[1].length).map(([t, m]) => `- ${link(themeFile(t), t)} (${m.length})`), ``,
    `## Projects (${projects.length})`, ...projects.slice().sort((a, b) => a.label.localeCompare(b.label)).map((p) => `- ${link(projFile(p.nodeKey), p.label)}`),
  ].join("\n") });

  // projects
  for (const p of projects) {
    const myCaps = (projCaps.get(p.id) ?? []).sort((a, b) => a.cap.label.localeCompare(b.cap.label));
    const decisions = evaluated.get(p.id) ?? [];
    const product = projProduct.get(p.id);
    const rep = reports.get(p.nodeKey);
    files.push({ path: `${projFile(p.nodeKey)}.md`, content: [
      `---`, `type: project`, `slug: ${p.nodeKey}`, product ? `product: ${product.label}` : ``, `---`, ``,
      `# ${p.label}`, ``, rep?.purpose ? `> ${rep.purpose}` : ``, ``,
      `## Capabilities`, ...myCaps.map(({ cap, provenance }) => `- ${link(capFile(cap.label), cap.label)} \`${provenance}\``), ``,
      decisions.length ? `## Decisions` : ``, ...decisions.map((d) => `- **${d.verdict}** ${link(candFile(String(d.cand.data.fullName ?? d.cand.label)), String(d.cand.data.fullName ?? d.cand.label))}${d.reasonCode ? ` \`${d.reasonCode}\`` : ""}${d.oneLine ? ` — ${d.oneLine}` : ""}`),
      rep?.report ? `\n## Report\n\n${rep.report}` : ``,
    ].filter((l) => l !== ``).join("\n") + "\n" });
  }

  // capabilities
  for (const c of caps) {
    const projs = (capProjs.get(c.id) ?? []);
    const neigh = (adj.get(c.id) ?? []).sort((a, b) => b.w - a.w).slice(0, 8);
    const mods = Array.isArray(c.data.modality) ? (c.data.modality as string[]) : [];
    files.push({ path: `${capFile(c.label)}.md`, content: [
      `---`, `type: capability`, mods.length ? `modality: [${mods.join(", ")}]` : ``, c.data.themeName ? `theme: ${c.data.themeName}` : ``, c.data.keystone ? `keystone: true` : ``, `---`, ``,
      `# ${c.label}`, ``,
      projs.length ? `Used in: ${projs.map((p) => link(projFile(p.nodeKey), p.label)).join(", ")}` : ``, ``,
      neigh.length ? `## Adjacent capabilities` : ``, ...neigh.map((n) => `- ${link(capFile(n.cap.label), n.cap.label)} (${n.w.toFixed(2)})`),
      c.data.themeName ? `\nTheme: ${link(themeFile(String(c.data.themeName)), String(c.data.themeName))}` : ``,
    ].filter((l) => l !== ``).join("\n") + "\n" });
  }

  // candidates
  for (const c of cands) {
    const fullName = String(c.data.fullName ?? c.label);
    const fillsC = candFills.get(c.id) ?? [];
    const dec = candDecisions.get(c.id) ?? [];
    files.push({ path: `${candFile(fullName)}.md`, content: [
      `---`, `type: candidate`, `repo: ${fullName}`, c.data.stars ? `stars: ${c.data.stars}` : ``, `---`, ``,
      `# ${fullName}`, c.data.url ? `\n${c.data.url}\n` : ``,
      fillsC.length ? `Fills: ${fillsC.map((f) => link(capFile(f.label), f.label)).join(", ")}` : ``, ``,
      dec.length ? `## Your decisions` : ``, ...dec.map((d) => `- **${d.verdict}** for ${link(projFile(d.proj.nodeKey), d.proj.label)}${d.reasonCode ? ` \`${d.reasonCode}\`` : ""}${d.oneLine ? ` — ${d.oneLine}` : ""}`),
    ].filter((l) => l !== ``).join("\n") + "\n" });
  }

  // themes
  for (const [name, members] of themeMembers) {
    if (members.length < 3) continue;
    const projSet = new Set<GNode>();
    for (const m of members) for (const p of capProjs.get(m.id) ?? []) projSet.add(p);
    files.push({ path: `${themeFile(name)}.md`, content: [
      `---`, `type: theme`, `---`, ``, `# Theme: ${name}`, ``,
      `## Capabilities`, ...members.slice().sort((a, b) => a.label.localeCompare(b.label)).map((m) => `- ${link(capFile(m.label), m.label)}`), ``,
      projSet.size ? `## Projects` : ``, ...[...projSet].map((p) => `- ${link(projFile(p.nodeKey), p.label)}`),
    ].filter((l) => l !== ``).join("\n") + "\n" });
  }

  return files;
}
