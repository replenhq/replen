// Atlas Carts — the "database" half of Atlas. The graph shows how decision units
// connect; a Cart shows the rows, with their real ontology attributes, browsable
// and groupable. (cart, from Latin charta, paper: the root of chart, charter,
// cartography.)
//
// CRITICAL: no new data. Every column here is read off the existing graph_nodes
// (kind, nodeKey, label, data{}) + graph_edges (kind, src, dst, weight, data{}),
// using the ontology's typed props (src/graph/ontology.ts). The graph plots these
// as dots and hides the rest; Carts surface them. Reads only, derived columns
// computed from edges. Starter Carts ship built in; user-saved Carts come later.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";

// ---------------------------------------------------------------------------
// Result contract (what the UI renders)
// ---------------------------------------------------------------------------
export type CartLayout = "table" | "board" | "cards" | "map" | "timeline";

export type CartColumnType =
  | "title"        // primary cell; the UI links it (href on the row)
  | "text"
  | "num"
  | "bar"          // amber degree/score bar, scaled to result.barMax
  | "modality"     // plain comma-joined list
  | "provenance"   // brightness hierarchy, no pill
  | "date";

export type CartColumn = { key: string; label: string; type: CartColumnType; align?: "right" };

export type CartCardMeta = { icon: "star" | "hex" | "doc" | "split"; text: string };
export type CartCard = {
  key: string;
  title: string;
  href: string | null;
  meta: CartCardMeta[];
  match: number | null; // 0..100, the amber "Match" bar; null hides it
  sub: string | null;   // a projected-action line when there's no score
};
export type CartGroup = { key: string; label: string; total: number; cards: CartCard[] };

export type CartResult = {
  id: string;
  name: string;
  description: string;
  icon: string;
  layout: CartLayout;
  count: number;
  // table/cards
  columns: CartColumn[];
  rows: Record<string, string | number | boolean | string[] | null>[];
  barMax: number;
  // board
  groups?: CartGroup[];
  // footer
  summary?: { text: string; accent?: boolean }[];
};

export type CartFilters = {
  provenance?: string;
  modality?: string;
  verdict?: string;
  q?: string;
};

// ---------------------------------------------------------------------------
// Starter Carts (the rail). id is the URL key; layout is the default view.
// ---------------------------------------------------------------------------
export type CartMeta = { id: string; name: string; description: string; icon: string; layout: CartLayout };

export const CARTS: CartMeta[] = [
  { id: "blind-spots", name: "Blind spots", icon: "gap", layout: "table",
    description: "capabilities you have with no tool, library or candidate filling them" },
  { id: "triage", name: "Triage board", icon: "board", layout: "board",
    description: "candidates and suggestions, grouped by verdict" },
  { id: "keystones", name: "Keystones", icon: "cards", layout: "table",
    description: "the capabilities that recur across the most repos" },
  { id: "brought-in", name: "Brought in", icon: "table", layout: "table",
    description: "candidates you adopted, ported, or cherry-picked" },
  { id: "stale", name: "Stale deferrals", icon: "table", layout: "table",
    description: "verdicts to port or cherry-pick that you haven't acted on, oldest first" },
  { id: "by-domain", name: "By domain", icon: "map", layout: "table",
    description: "capabilities grouped by the domain they belong to" },
];

const PROV_ORDER = ["grounded", "extracted", "inferred", "ambiguous"];
const strongerProv = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return PROV_ORDER.indexOf(a) <= PROV_ORDER.indexOf(b) ? a : b;
};

// Board column order + display labels. Suggestions land in suggested/evaluating;
// candidates land in their EVALUATED verdict.
const BOARD_ORDER = ["suggested", "evaluating", "adopt", "port", "cherry-pick", "clean-room", "skip"] as const;
const BOARD_LABEL: Record<string, string> = {
  suggested: "Suggested", evaluating: "Evaluating", adopt: "Adopt", port: "Port",
  "cherry-pick": "Cherry-pick", "clean-room": "Clean-room", skip: "Skip", upgrade: "Upgrade",
};

// ---------------------------------------------------------------------------
// Engine — load the graph once, compute per-node attributes, then each Cart is
// a cheap projection over those attributes.
// ---------------------------------------------------------------------------
type Attrs = {
  id: number; kind: string; nodeKey: string; label: string;
  updatedAt: number;
  // capability
  provenance: string | null; modality: string[]; theme: string | null;
  degree: number; waypoint: boolean; projects: number; fillers: number; evidence: number; domains: string[];
  // candidate / suggestion
  fullName: string | null; stars: number | null; url: string | null;
  verdict: string | null; effort: string | null; score: number | null; reasonCode: string | null; evaluatedAt: string | null;
  fills: string | null; status: string | null; projected: string | null;
};

export type CartEngine = { attrs: Map<number, Attrs>; byKind: Map<string, Attrs[]>; nodeCount: number; edgeCount: number };

const j = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export async function buildCartEngine(userId: number): Promise<CartEngine> {
  const [rawNodes, rawEdges] = await Promise.all([
    db.select({ id: schema.graphNodes.id, kind: schema.graphNodes.kind, nodeKey: schema.graphNodes.nodeKey, label: schema.graphNodes.label, data: schema.graphNodes.data, updatedAt: schema.graphNodes.updatedAt })
      .from(schema.graphNodes).where(eq(schema.graphNodes.userId, userId)),
    db.select({ kind: schema.graphEdges.kind, srcId: schema.graphEdges.srcId, dstId: schema.graphEdges.dstId, weight: schema.graphEdges.weight, data: schema.graphEdges.data })
      .from(schema.graphEdges).where(eq(schema.graphEdges.userId, userId)),
  ]);

  const attrs = new Map<number, Attrs>();
  const label = new Map<number, string>();
  const kindOf = new Map<number, string>();
  for (const n of rawNodes) {
    const d = j(n.data);
    label.set(n.id, n.label);
    kindOf.set(n.id, n.kind);
    attrs.set(n.id, {
      id: n.id, kind: n.kind, nodeKey: n.nodeKey, label: n.label,
      updatedAt: n.updatedAt ? Math.floor(n.updatedAt.getTime() / 1000) : 0,
      provenance: null, modality: Array.isArray(d.modality) ? (d.modality as string[]) : [],
      theme: (d.themeName as string) ?? null, degree: (d.degree as number) ?? 0,
      waypoint: !!d.waypoint, projects: 0, fillers: 0, evidence: 0, domains: [],
      fullName: (d.fullName as string) ?? null, stars: (d.stars as number) ?? null, url: (d.url as string) ?? null,
      verdict: null, effort: null, score: null, reasonCode: null, evaluatedAt: null,
      fills: null, status: null, projected: (d.projected as string) ?? null,
    });
  }

  // Edge-derived attributes. One pass; tolerant of partial data.
  const projectOfCap = new Map<number, Set<number>>(); // capId -> set of project node ids (for domain rollup)
  for (const e of rawEdges) {
    const ed = j(e.data);
    const src = attrs.get(e.srcId);
    const dst = attrs.get(e.dstId);
    if (e.kind === "HAS_CAPABILITY" && dst) {
      dst.projects += 1;
      dst.provenance = strongerProv(dst.provenance, (ed.provenance as string) ?? null);
      if (Array.isArray(ed.modality) && (ed.modality as string[]).length && !dst.modality.length) dst.modality = ed.modality as string[];
      if (Array.isArray(ed.paths)) dst.evidence += (ed.paths as string[]).length;
      if (src) { (projectOfCap.get(e.dstId) ?? projectOfCap.set(e.dstId, new Set()).get(e.dstId)!).add(e.srcId); }
    } else if (e.kind === "FILLS" && dst) {
      dst.fillers += 1; // capability fillers
      if (src) src.fills = dst.label; // candidate -> capability label
    } else if (e.kind === "EVALUATED" && dst) {
      // Keep the most decisive verdict if a candidate is evaluated by several
      // projects (highest score wins; ties keep the first seen).
      const score = typeof ed.score === "number" ? (ed.score as number) : null;
      if (dst.verdict == null || (score != null && (dst.score == null || score > dst.score))) {
        dst.verdict = (ed.verdict as string) ?? dst.verdict;
        dst.effort = (ed.effort as string) ?? dst.effort;
        dst.score = score ?? dst.score;
        dst.reasonCode = (ed.reasonCode as string) ?? dst.reasonCode;
        dst.evaluatedAt = (ed.at as string) ?? dst.evaluatedAt;
      }
    } else if (e.kind === "SUGGESTED" && dst) {
      dst.status = (ed.status as string) ?? dst.status;
      if (ed.projected && !dst.projected) dst.projected = ed.projected as string;
    }
  }

  // Domain rollup for capabilities: a capability's domains are the IN_DOMAIN
  // tags of the projects that HAS_CAPABILITY it.
  const projectDomains = new Map<number, string[]>();
  for (const e of rawEdges) {
    if (e.kind === "IN_DOMAIN") {
      const arr = projectDomains.get(e.srcId) ?? [];
      const dl = label.get(e.dstId);
      if (dl) arr.push(dl);
      projectDomains.set(e.srcId, arr);
    }
  }
  for (const [capId, projSet] of projectOfCap) {
    const cap = attrs.get(capId);
    if (!cap) continue;
    const set = new Set<string>();
    for (const pid of projSet) for (const d of projectDomains.get(pid) ?? []) set.add(d);
    cap.domains = [...set];
  }

  const byKind = new Map<string, Attrs[]>();
  for (const a of attrs.values()) {
    const arr = byKind.get(a.kind) ?? [];
    arr.push(a);
    byKind.set(a.kind, arr);
  }
  return { attrs, byKind, nodeCount: rawNodes.length, edgeCount: rawEdges.length };
}

// Cheap per-cart counts for the rail, off the same engine.
export function cartCount(engine: CartEngine, id: string): number {
  const caps = engine.byKind.get("capability") ?? [];
  const cands = engine.byKind.get("candidate") ?? [];
  const suggs = engine.byKind.get("suggestion") ?? [];
  switch (id) {
    case "blind-spots": return caps.filter((c) => c.projects > 0 && c.fillers === 0).length;
    case "triage": return suggs.length + cands.filter((c) => c.verdict).length;
    case "keystones": return caps.filter((c) => c.waypoint || c.degree >= 3).length;
    case "brought-in": return cands.filter((c) => ["adopt", "port", "cherry-pick", "clean-room"].includes(c.verdict ?? "")).length;
    case "stale": return cands.filter((c) => ["port", "cherry-pick", "clean-room"].includes(c.verdict ?? "")).length;
    case "by-domain": return caps.filter((c) => c.domains.length > 0).length;
    default: return 0;
  }
}

const matchFilters = (a: Attrs, f: CartFilters): boolean => {
  if (f.provenance && a.provenance !== f.provenance) return false;
  if (f.modality && !a.modality.includes(f.modality)) return false;
  if (f.verdict && a.verdict !== f.verdict) return false;
  if (f.q) {
    const hay = `${a.label} ${a.fullName ?? ""} ${a.fills ?? ""} ${a.theme ?? ""}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// runCart — project the engine into a CartResult for one cart + layout.
// ---------------------------------------------------------------------------
export function runCart(engine: CartEngine, id: string, opts: { layout?: CartLayout; filters?: CartFilters } = {}): CartResult {
  const meta = CARTS.find((c) => c.id === id) ?? CARTS[0];
  const layout = opts.layout ?? meta.layout;
  const f = opts.filters ?? {};
  const caps = (engine.byKind.get("capability") ?? []).filter((a) => matchFilters(a, f));
  const cands = (engine.byKind.get("candidate") ?? []).filter((a) => matchFilters(a, f));
  const suggs = (engine.byKind.get("suggestion") ?? []).filter((a) => matchFilters(a, f));

  const base = { id: meta.id, name: meta.name, description: meta.description, icon: meta.icon, layout };

  // ---- Triage as a flat table (the Board↔Table flip) ---------------------
  if (id === "triage" && layout === "table") {
    const members = [
      ...suggs.map((s) => ({ a: s, verdict: s.status === "starred" ? "evaluating" : "suggested" })),
      ...cands.filter((c) => c.verdict).map((c) => ({ a: c, verdict: c.verdict! })),
    ];
    members.sort((x, y) => BOARD_ORDER.indexOf(x.verdict as typeof BOARD_ORDER[number]) - BOARD_ORDER.indexOf(y.verdict as typeof BOARD_ORDER[number]) || (y.a.score ?? 0) - (x.a.score ?? 0));
    const columns: CartColumn[] = [
      col("fullName", "Candidate", "title"), col("verdict", "Verdict", "text"),
      col("fills", "Fills", "text"), col("score", "Match", "bar"),
      col("stars", "Stars", "num"), col("evaluatedAt", "Decided", "date"),
    ];
    const rows = members.map(({ a, verdict }) => {
      const r = toRow(a, columns, candHref(a));
      r.verdict = BOARD_LABEL[verdict] ?? verdict;
      r.fills = a.fills ?? a.projected ?? null;
      return r;
    });
    return { ...base, layout: "table", count: rows.length, columns, rows, barMax: 100,
      summary: [{ text: `${rows.length} in triage` }] };
  }

  // ---- Triage board ------------------------------------------------------
  if (id === "triage") {
    const buckets = new Map<string, CartCard[]>();
    const push = (k: string, card: CartCard) => { (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(card); };
    for (const s of suggs) {
      push(s.status === "starred" ? "evaluating" : "suggested", {
        key: `s:${s.nodeKey}`, title: s.fullName ?? s.label, href: s.url,
        meta: starMeta(s.stars).concat(s.projected ? [{ icon: "split", text: s.projected }] : []),
        match: null, sub: null,
      });
    }
    for (const c of cands) {
      if (!c.verdict) continue;
      push(c.verdict, {
        key: `c:${c.nodeKey}`, title: c.fullName ?? c.label, href: c.url,
        meta: starMeta(c.stars).concat(c.fills ? [{ icon: "hex", text: `fills ${c.fills}` }] : []),
        match: c.score != null ? Math.round(c.score * 100) : null,
        sub: c.score == null && c.effort ? c.effort : null,
      });
    }
    const present = BOARD_ORDER.filter((k) => buckets.has(k));
    const order = present.length ? present : (["suggested"] as string[]);
    const groups: CartGroup[] = order.map((k) => {
      const cards = (buckets.get(k) ?? []).sort((a, b) => (b.match ?? -1) - (a.match ?? -1));
      return { key: k, label: BOARD_LABEL[k] ?? k, total: cards.length, cards };
    });
    const count = groups.reduce((s, g) => s + g.total, 0);
    return { ...base, layout: "board", count, columns: [], rows: [], barMax: 100, groups,
      summary: [{ text: `${count} in triage` }, { text: `${(buckets.get("suggested")?.length ?? 0)} new` }] };
  }

  // ---- Table carts -------------------------------------------------------
  let rows: Attrs[] = [];
  let columns: CartColumn[] = [];
  let summary: { text: string; accent?: boolean }[] = [];
  let barKey = "degree";

  if (id === "blind-spots") {
    rows = caps.filter((c) => c.projects > 0 && c.fillers === 0).sort((a, b) => b.degree - a.degree);
    columns = [
      col("label", "Capability", "title"), col("provenance", "Provenance", "provenance"),
      col("modality", "Modality", "modality"), col("theme", "Theme", "text"),
      col("degree", "Degree", "bar"), col("projects", "Projects", "num"),
      col("evidence", "Evidence", "num"), col("updatedAt", "Last seen", "date"),
    ];
    const grounded = rows.filter((r) => r.provenance === "grounded").length;
    summary = [
      { text: `${rows.length} capabilities` }, { text: `${grounded} grounded` },
      { text: "0 tools fill", accent: true },
    ];
  } else if (id === "keystones") {
    rows = caps.filter((c) => c.waypoint || c.degree >= 3).sort((a, b) => b.degree - a.degree);
    columns = [
      col("label", "Capability", "title"), col("theme", "Theme", "text"),
      col("modality", "Modality", "modality"), col("degree", "Recurrence", "bar"),
      col("projects", "Projects", "num"), col("fillers", "Filled by", "num"),
    ];
    summary = [{ text: `${rows.length} keystones` }, { text: `${rows.filter((r) => r.waypoint).length} waypoints` }];
  } else if (id === "brought-in") {
    rows = cands.filter((c) => ["adopt", "port", "cherry-pick", "clean-room"].includes(c.verdict ?? ""))
      .sort((a, b) => (b.evaluatedAt ?? "").localeCompare(a.evaluatedAt ?? ""));
    columns = [
      col("fullName", "Candidate", "title"), col("verdict", "Verdict", "text"),
      col("effort", "Effort", "text"), col("fills", "Fills", "text"),
      col("score", "Match", "bar"), col("stars", "Stars", "num"), col("evaluatedAt", "Decided", "date"),
    ];
    barKey = "score";
    summary = [{ text: `${rows.length} brought in` }];
  } else if (id === "stale") {
    rows = cands.filter((c) => ["port", "cherry-pick", "clean-room"].includes(c.verdict ?? ""))
      .sort((a, b) => (a.evaluatedAt ?? "").localeCompare(b.evaluatedAt ?? ""));
    columns = [
      col("fullName", "Candidate", "title"), col("verdict", "Verdict", "text"),
      col("fills", "Fills", "text"), col("score", "Match", "bar"), col("evaluatedAt", "Deferred since", "date"),
    ];
    barKey = "score";
    summary = [{ text: `${rows.length} waiting`, accent: rows.length > 0 }];
  } else if (id === "by-domain") {
    rows = caps.filter((c) => c.domains.length > 0)
      .sort((a, b) => (a.domains[0] ?? "").localeCompare(b.domains[0] ?? "") || b.degree - a.degree);
    columns = [
      col("label", "Capability", "title"), col("domains", "Domain", "modality"),
      col("modality", "Modality", "modality"), col("degree", "Degree", "bar"), col("projects", "Projects", "num"),
    ];
    summary = [{ text: `${rows.length} capabilities` }, { text: `${new Set(rows.flatMap((r) => r.domains)).size} domains` }];
  }

  const barMax = Math.max(1, ...rows.map((r) => Number((r as unknown as Record<string, number>)[barKey] ?? 0) || (barKey === "score" ? (r.score ?? 0) : 0)));
  const outRows = rows.map((r) => toRow(r, columns, r.kind === "candidate" ? candHref(r) : capHref(r)));
  return { ...base, layout: "table", count: rows.length, columns, rows: outRows, barMax, summary };
}

// ---- row / href helpers -----------------------------------------------------
const col = (key: string, label: string, type: CartColumnType): CartColumn =>
  ({ key, label, type, ...(type === "num" || type === "bar" ? { align: "right" as const } : {}) });

const starMeta = (stars: number | null): CartCardMeta[] =>
  stars != null ? [{ icon: "star", text: `${fmtStars(stars)} stars` }] : [];

const capHref = (a: Attrs): string | null => `/atlas?node=capability:${encodeURIComponent(a.nodeKey)}`;
const candHref = (a: Attrs): string | null => a.url ?? `/atlas?node=candidate:${encodeURIComponent(a.nodeKey)}`;

function toRow(a: Attrs, columns: CartColumn[], href: string | null): Record<string, string | number | boolean | string[] | null> {
  const r: Record<string, string | number | boolean | string[] | null> = { __href: href };
  for (const c of columns) {
    const v = (a as unknown as Record<string, unknown>)[c.key];
    if (c.type === "bar") r[c.key] = c.key === "score" ? (a.score != null ? Math.round(a.score * 100) : 0) : (typeof v === "number" ? v : 0);
    else if (c.type === "modality") r[c.key] = Array.isArray(v) ? (v as string[]) : [];
    else if (c.type === "num") r[c.key] = typeof v === "number" ? v : 0;
    else if (c.type === "date") r[c.key] = typeof v === "number" ? v : (typeof v === "string" ? v : null);
    else r[c.key] = (v as string) ?? null;
  }
  return r;
}

export function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtAgo(epochOrIso: string | number | null): string {
  if (epochOrIso == null) return "";
  let then: number;
  if (typeof epochOrIso === "number") then = epochOrIso * 1000;
  else { const t = Date.parse(epochOrIso); if (Number.isNaN(t)) return String(epochOrIso); then = t; }
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
