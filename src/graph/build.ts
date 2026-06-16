// Atlas §0 — the per-user knowledge graph builder. Assembles a materialized
// graph from data we already store (facets, triage_events, product_key,
// catalogue) and persists it to graph_nodes / graph_edges. Deterministic and
// idempotent: rebuilding replaces the user's graph atomically, and a content
// hash lets the pipeline skip rebuilds when nothing changed.
//
// Nodes:  project · product · capability · tool · candidate · suggestion ·
//         goal · domain · lesson · boundary
// Edges (within-user, all built here):
//   MEMBER_OF      project   → product
//   USES           project   → tool          {version}
//   HAS_CAPABILITY project   → capability   {provenance, modality, paths}
//   ADJACENT_TO    capability→ capability   {cosine}      (band: related-but-distinct)
//   RELATES_TO     project   → project      {cosine, sharedCaps}
//   EVALUATED      project   → candidate    {verdict, reasonCode, score, effort, oneLine, at}
//   FILLS          candidate → capability   (from the matched facet at triage time)
//   SUGGESTED      project   → suggestion
//   GOAL_OF        project   → goal
//   IN_DOMAIN      project   → domain        (from the dense tag cloud; domain
//                  nodes carry projectCount + a k-anon cross-user user count so
//                  sector patterns surface — "these 5 are UK-property")
//   INSIGHT_FOR    project   → lesson|boundary   (generative-skip insights)
//   FROM_CANDIDATE lesson|boundary → candidate   (the repo that prompted it)
// (ENDORSED_BY_SIMILAR is the one cross-user edge; added by Leaps in §1.)

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { parseStoredFacetEmbeddings, parseStoredEmbedding, cosineSimilarity, normalizeVec } from "../lib/embeddings";
import { deriveProductKey } from "../projects/product-key";
import { louvain } from "./community";
import { type Modality, type Provenance } from "../projects/modality";
import { isNoiseFacetLabel, isGenericProbeFacetLabel } from "../projects/doc-sections";
import { parseTechSummaryDeps } from "../fetchers/stack-watch/registry";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Adjacency band: related but not the same capability (>HI is basically a dup,
// <LO is unrelated). Cap neighbours per capability so the graph stays lean.
const ADJ_LO = Math.max(0, parseFloat(process.env.REPLEN_GRAPH_ADJ_LO ?? "0.50"));
const ADJ_HI = Math.min(1, parseFloat(process.env.REPLEN_GRAPH_ADJ_HI ?? "0.88"));
const ADJ_MAX_NEIGHBOURS = Math.max(1, parseInt(process.env.REPLEN_GRAPH_ADJ_MAX ?? "6", 10) || 6);
// Project↔project relatedness threshold (centroid cosine).
const RELATES_MIN = Math.max(0, parseFloat(process.env.REPLEN_GRAPH_RELATES_MIN ?? "0.55"));

type NodeDraft = { kind: string; nodeKey: string; label: string; data: Record<string, unknown> };
type EdgeDraft = { kind: string; srcKey: string; dstKey: string; weight: number | null; data: Record<string, unknown> };
const nk = (kind: string, key: string) => `${kind} ${key}`;

export type GraphBuildResult = { built: boolean; nodeCount: number; edgeCount: number; hash: string; reason: string };

/** Build (or rebuild) the user's Atlas graph. Returns counts + whether it changed. */
export async function buildUserGraph(userId: number, opts: { force?: boolean } = {}): Promise<GraphBuildResult> {
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      eq(schema.projectProfiles.included, true),
    ));

  const nodes = new Map<string, NodeDraft>();
  const edges: EdgeDraft[] = [];
  const addNode = (n: NodeDraft) => { if (!nodes.has(nk(n.kind, n.nodeKey))) nodes.set(nk(n.kind, n.nodeKey), n); };

  // Per-capability accumulators (centroid vector for adjacency, modality union).
  const capVec = new Map<string, { sum: number[]; n: number }>();
  const capModality = new Map<string, Set<Modality>>();
  // Raw facets across all projects — capability nodes are emitted AFTER the
  // near-duplicate merge pass below, not during the project loop.
  const rawFacets: Array<{ slug: string; key: string; label: string; vec: number[]; modality: Modality[]; provenance: Provenance; paths: string[] }> = [];
  const capCanon = new Map<string, string>();   // facet key → canonical capability key
  const capAliases = new Map<string, string[]>(); // canonical key → merged-away labels

  // Facet hygiene at BUILD time, same rules the inventory route applies at
  // read time: doc-section noise ("Run locally (SQLite, no infra)") and a
  // project's own name/slug are not capabilities and must not become nodes.
  const dropNames = new Set<string>();
  for (const p of projects) {
    for (const s of [p.slug, p.name, p.githubFullName?.split("/")[1]]) {
      if (!s) continue;
      const n = norm(s);
      if (n) dropNames.add(n);
    }
  }

  // User curation rules (webapp dossier): delete / rename / merge / confirm.
  // Re-applied here so a facet regeneration can't resurrect a curated label.
  const curations = await db.select().from(schema.capabilityCurations)
    .where(eq(schema.capabilityCurations.userId, userId));
  const curationByKey = new Map(curations.map((c) => [c.normLabel, c]));
  // Tool prefs (plan / migrate-off) attach onto tool nodes.
  const toolPrefRows = await db.select().from(schema.toolPrefs)
    .where(eq(schema.toolPrefs.userId, userId));
  const toolPrefByKey = new Map(toolPrefRows.map((t) => [t.tool, t]));

  // ── projects, products, capabilities, HAS_CAPABILITY, MEMBER_OF ──
  const projCentroid = new Map<string, number[] | null>(); // slug → centroid
  const projCaps = new Map<string, Set<string>>();          // slug → cap keys
  const productMembers = new Map<string, string[]>();        // productKey → slugs
  for (const p of projects) {
    addNode({ kind: "project", nodeKey: p.slug, label: p.name ?? p.slug, data: { slug: p.slug, name: p.name, githubFullName: p.githubFullName } });
    projCentroid.set(p.slug, parseStoredEmbedding(p.embedding ?? null));

    // Collect product membership; emitted AFTER the loop, but only for products
    // that actually group ≥2 repos. A single-repo "product" is just the repo —
    // an oversized lonely node with one MEMBER_OF edge — so it's suppressed.
    const productKey = p.productKey ?? deriveProductKey(p.githubFullName);
    if (productKey) (productMembers.get(productKey) ?? productMembers.set(productKey, []).get(productKey)!).push(p.slug);

    // Tools — the external products/runtimes the project actually uses (from
    // the manifest deps, with pinned versions when the agent reported them).
    // A distinct node kind: "supabase" is something you USE, not something
    // you DO — and awareness events (pricing, CVEs, EOLs) anchor to it.
    let versions: Record<string, string> = {};
    try { versions = p.depVersions ? JSON.parse(p.depVersions) : {}; } catch { /* */ }
    const toolNames = new Set<string>([...parseTechSummaryDeps(p.techSummary), ...Object.keys(versions).map((k) => k.toLowerCase())]);
    for (const dep of [...toolNames].slice(0, 60)) {
      const key = dep.toLowerCase();
      if (!key || key.length < 2) continue;
      const pref = toolPrefByKey.get(key);
      addNode({
        kind: "tool", nodeKey: key, label: dep,
        data: { name: dep, ...(pref?.plan ? { plan: pref.plan } : {}), ...(pref?.migrateOff ? { migrateOff: true } : {}) },
      });
      edges.push({
        kind: "USES", srcKey: nk("project", p.slug), dstKey: nk("tool", key),
        weight: null, data: versions[dep] ? { version: versions[dep] } : {},
      });
    }

    for (const f of parseStoredFacetEmbeddings(p.facetEmbeddings ?? null)) {
      let label = f.label;
      let provenance = (f.provenance ?? "inferred") as Provenance;
      // Apply curation rules (regeneration-proof): delete drops the facet,
      // rename/merge re-labels it, confirm upgrades trust.
      const rule = curationByKey.get(norm(label));
      if (rule) {
        if (rule.action === "delete") continue;
        if ((rule.action === "rename" || rule.action === "merge") && rule.target) label = rule.target;
        if (rule.action === "confirm") provenance = "grounded";
      }
      const key = norm(label);
      if (!key) continue;
      if (isNoiseFacetLabel(label) || dropNames.has(key)) continue;
      // Ambiguous facets (raw doc-section headings, low-confidence inference)
      // never become graph nodes — they pollute themes, waypoints, blind-spot
      // counts, and the Atlas view. Matching still uses them, hard-gated by
      // the provenance premium; the graph is the curated view.
      if (provenance === "ambiguous") continue;
      rawFacets.push({ slug: p.slug, key, label, vec: f.vec, modality: f.modality ?? [], provenance, paths: f.paths ?? [] });
    }
  }

  // Emit product nodes + MEMBER_OF edges, but only where the product groups
  // ≥2 of the user's repos (a 1-repo product is noise — see the loop above).
  for (const [productKey, members] of productMembers) {
    if (members.length < 2) continue;
    addNode({ kind: "product", nodeKey: productKey, label: productKey, data: { key: productKey, repoCount: members.length } });
    for (const slug of members) edges.push({ kind: "MEMBER_OF", srcKey: nk("project", slug), dstKey: nk("product", productKey), weight: null, data: {} });
  }

  // ── capability merging: near-duplicate labels collapse into ONE node ──
  // Different projects phrase the same capability differently ("Firebase
  // Auth" / "Firebase Authentication"). Above MERGE_MIN cosine they ARE the
  // same capability — merge them, keep the most-used phrasing as the label,
  // carry the others as aliases. ADJ_HI has always said ">0.88 is basically
  // a dup"; this is where the dup actually gets collapsed instead of just
  // not linked.
  const MERGE_MIN = Math.min(1, Math.max(0.85, parseFloat(process.env.REPLEN_GRAPH_MERGE_MIN ?? "0.92")));
  // Facets embed DESCRIPTORS, so the same capability phrased two ways by two
  // projects lands around 0.85-0.90, not 0.92+. Lexical evidence closes the
  // gap: when every token of the shorter label matches a token of the longer
  // (equal, or a ≥3-char prefix: "auth" ⊂ "authentication"), a much lower
  // cosine bar suffices — "firebase auth"/"firebase authentication" merges at
  // 0.876 while "telemetry analysis"/"telemetry collection" never can.
  const MERGE_LEX_MIN = Math.min(1, Math.max(0.7, parseFloat(process.env.REPLEN_GRAPH_MERGE_LEX_MIN ?? "0.78")));
  const labelsSimilar = (a: string, b: string): boolean => {
    const ta = a.split(" ").filter(Boolean);
    const tb = b.split(" ").filter(Boolean);
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return short.every((s) => long.some((l) => {
      if (s === l) return true;
      const [p, w] = s.length <= l.length ? [s, l] : [l, s];
      return p.length >= 3 && w.startsWith(p);
    }));
  };
  {
    const keyAgg = new Map<string, { sum: number[]; n: number; projects: Set<string>; label: string }>();
    for (const f of rawFacets) {
      const acc = keyAgg.get(f.key) ?? { sum: new Array(f.vec.length).fill(0), n: 0, projects: new Set<string>(), label: f.label };
      for (let i = 0; i < f.vec.length; i++) acc.sum[i] += f.vec[i];
      acc.n++; acc.projects.add(f.slug);
      keyAgg.set(f.key, acc);
    }
    const keys = [...keyAgg.keys()];
    const centroid = new Map(keys.map((k) => { const a = keyAgg.get(k)!; return [k, normalizeVec(a.sum.map((x) => x / a.n))] as const; }));
    // union-find over near-duplicate pairs
    const parent = new Map(keys.map((k) => [k, k]));
    const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const cos = cosineSimilarity(centroid.get(keys[i])!, centroid.get(keys[j])!);
        if (!Number.isFinite(cos)) continue;
        const isDup = cos >= MERGE_MIN || (cos >= MERGE_LEX_MIN && labelsSimilar(keys[i], keys[j]));
        if (isDup) {
          const ri = find(keys[i]); const rj = find(keys[j]);
          if (ri !== rj) parent.set(rj, ri);
        }
      }
    }
    // canonical member per cluster: most projects, tie → shortest label
    const groups = new Map<string, string[]>();
    for (const k of keys) { const r = find(k); (groups.get(r) ?? groups.set(r, []).get(r)!).push(k); }
    for (const members of groups.values()) {
      if (members.length < 2) { capCanon.set(members[0], members[0]); continue; }
      const canonical = members.slice().sort((a, b) =>
        (keyAgg.get(b)!.projects.size - keyAgg.get(a)!.projects.size) ||
        (keyAgg.get(a)!.label.length - keyAgg.get(b)!.label.length))[0];
      for (const m of members) {
        capCanon.set(m, canonical);
        if (m !== canonical) {
          const aliases = capAliases.get(canonical) ?? [];
          if (!aliases.includes(keyAgg.get(m)!.label)) aliases.push(keyAgg.get(m)!.label);
          capAliases.set(canonical, aliases);
        }
      }
    }
    // emit capability nodes + HAS_CAPABILITY edges on the canonical keys,
    // deduping per (project, capability) and keeping the strongest provenance
    const PROV_ORDER: Record<string, number> = { grounded: 3, extracted: 2, inferred: 1, ambiguous: 0 };
    const hasCapEdge = new Map<string, EdgeDraft>();
    for (const f of rawFacets) {
      const ckey = capCanon.get(f.key) ?? f.key;
      const canonicalLabel = keyAgg.get(ckey)!.label;
      addNode({ kind: "capability", nodeKey: ckey, label: canonicalLabel, data: { label: canonicalLabel } });
      const caps = projCaps.get(f.slug) ?? new Set<string>();
      caps.add(ckey); projCaps.set(f.slug, caps);
      const ek = `${f.slug}|${ckey}`;
      const existing = hasCapEdge.get(ek);
      // Paths union across merged phrasings; provenance keeps the strongest.
      const mergedPaths = [...new Set([...(existing ? (existing.data.paths as string[] | undefined) ?? [] : []), ...f.paths])];
      if (!existing || (PROV_ORDER[f.provenance] ?? 1) > (PROV_ORDER[String(existing.data.provenance)] ?? 1)) {
        hasCapEdge.set(ek, {
          kind: "HAS_CAPABILITY", srcKey: nk("project", f.slug), dstKey: nk("capability", ckey),
          weight: 1, data: { provenance: f.provenance, modality: f.modality, ...(mergedPaths.length ? { paths: mergedPaths } : {}) },
        });
      } else if (mergedPaths.length && existing) {
        existing.data.paths = mergedPaths;
      }
      const acc = capVec.get(ckey) ?? { sum: new Array(f.vec.length).fill(0), n: 0 };
      for (let i = 0; i < f.vec.length; i++) acc.sum[i] += f.vec[i];
      acc.n += 1; capVec.set(ckey, acc);
      if (f.modality.length) { const s = capModality.get(ckey) ?? new Set<Modality>(); f.modality.forEach((m) => s.add(m)); capModality.set(ckey, s); }
    }
    edges.push(...hasCapEdge.values());
  }

  // attach modality union + aliases onto capability nodes
  for (const [key, mods] of capModality) {
    const n = nodes.get(nk("capability", key));
    if (n) n.data.modality = [...mods];
  }
  for (const [key, aliases] of capAliases) {
    const n = nodes.get(nk("capability", key));
    if (n) n.data.aliases = aliases;
  }

  // ── ADJACENT_TO (capability ↔ capability, banded, top-K) ──
  const capKeys = [...capVec.keys()];
  const capCentroid = new Map<string, number[]>();
  // Normalize each averaged centroid to unit length — cosineSimilarity is a
  // bare dot product, so the mean of unit facet vectors must be re-normalized
  // or the ADJ_LO/ADJ_HI band reads systematically deflated, non-cosine scores.
  for (const k of capKeys) { const a = capVec.get(k)!; capCentroid.set(k, normalizeVec(a.sum.map((x) => x / a.n))); }
  const capEdges: Array<{ a: string; b: string; w: number }> = []; // for community detection (§5)
  for (let i = 0; i < capKeys.length; i++) {
    const a = capCentroid.get(capKeys[i])!;
    const neigh: Array<{ k: string; cos: number }> = [];
    for (let j = 0; j < capKeys.length; j++) {
      if (i === j) continue;
      const cos = cosineSimilarity(a, capCentroid.get(capKeys[j])!);
      if (Number.isFinite(cos) && cos >= ADJ_LO && cos <= ADJ_HI) neigh.push({ k: capKeys[j], cos });
    }
    neigh.sort((x, y) => y.cos - x.cos);
    for (const { k, cos } of neigh.slice(0, ADJ_MAX_NEIGHBOURS)) {
      // one edge per unordered pair (skip the mirror)
      if (capKeys[i] < k) { edges.push({ kind: "ADJACENT_TO", srcKey: nk("capability", capKeys[i]), dstKey: nk("capability", k), weight: cos, data: {} }); capEdges.push({ a: capKeys[i], b: k, w: cos }); }
    }
  }

  // ── §5: themes (Louvain communities) + waypoint capabilities ──
  // Community edges = semantic adjacency + co-occurrence (capabilities used in
  // the same project belong together). Degree = adjacency + #projects.
  {
    const capCoocc = new Map<string, number>(); // "a|b" → weight
    for (const caps of projCaps.values()) {
      const arr = [...caps];
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] < arr[j] ? `${arr[i]}|${arr[j]}` : `${arr[j]}|${arr[i]}`;
        capCoocc.set(key, (capCoocc.get(key) ?? 0) + 0.5);
      }
    }
    const idx = new Map<string, number>(); capKeys.forEach((k, i) => idx.set(k, i));
    const cEdges: Array<{ a: number; b: number; w: number }> = [];
    for (const e of capEdges) cEdges.push({ a: idx.get(e.a)!, b: idx.get(e.b)!, w: e.w });
    for (const [pair, w] of capCoocc) { const [a, b] = pair.split("|"); if (idx.has(a) && idx.has(b)) cEdges.push({ a: idx.get(a)!, b: idx.get(b)!, w: Math.min(2, w) }); }
    const comm = louvain(capKeys.map((_, i) => i), cEdges);
    // degree (waypoint signal) = #projects with the cap + #adjacency edges
    const capProjectCount = new Map<string, number>();
    for (const caps of projCaps.values()) for (const c of caps) capProjectCount.set(c, (capProjectCount.get(c) ?? 0) + 1);
    const capDegree = new Map<string, number>();
    for (const k of capKeys) capDegree.set(k, (capProjectCount.get(k) ?? 0));
    for (const e of capEdges) { capDegree.set(e.a, (capDegree.get(e.a) ?? 0) + 1); capDegree.set(e.b, (capDegree.get(e.b) ?? 0) + 1); }
    // Name each community after its TWO highest-degree members — a single
    // member mislabels ("theme: Next.js" on an infra cluster); a pair reads
    // as a theme ("Next.js / Firebase Auth").
    const commMembers = new Map<number, string[]>();
    capKeys.forEach((k, i) => { const c = comm.get(i)!; (commMembers.get(c) ?? commMembers.set(c, []).get(c)!).push(k); });
    const commName = new Map<number, string>();
    for (const [c, members] of commMembers) {
      const ranked = members.slice().sort((x, y) => (capDegree.get(y) ?? 0) - (capDegree.get(x) ?? 0));
      const labels = ranked.slice(0, 2).map((k) => nodes.get(nk("capability", k))?.label ?? k);
      commName.set(c, labels.join(" / "));
    }
    // waypoint = top-degree capabilities overall
    const waypoints = new Set(capKeys.slice().sort((x, y) => (capDegree.get(y) ?? 0) - (capDegree.get(x) ?? 0)).slice(0, Math.max(3, Math.ceil(capKeys.length * 0.08))));
    capKeys.forEach((k, i) => {
      const n = nodes.get(nk("capability", k)); if (!n) return;
      const c = comm.get(i)!;
      n.data.theme = c; n.data.themeName = commName.get(c) ?? ""; n.data.degree = capDegree.get(k) ?? 0; n.data.waypoint = waypoints.has(k);
    });
  }

  // ── RELATES_TO (project ↔ project, centroid cosine + shared caps) ──
  const slugs = projects.map((p) => p.slug);
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const a = projCentroid.get(slugs[i]); const b = projCentroid.get(slugs[j]);
      // Shared capabilities, but NOT the generic-infra ones (FastAPI, PostgreSQL,
      // Redis…): two projects both using FastAPI is not a meaningful relationship,
      // and counting them linked unrelated domains (a defence backend to a
      // property CRM). Map cap keys to labels to apply the generic filter, then
      // surface the human-readable shared labels as the edge's reason.
      const shared = [...(projCaps.get(slugs[i]) ?? [])]
        .filter((c) => projCaps.get(slugs[j])?.has(c))
        .map((c) => nodes.get(nk("capability", c))?.label ?? c)
        .filter((label) => !isGenericProbeFacetLabel(label));
      const cos = a && b ? cosineSimilarity(a, b) : NaN;
      if ((Number.isFinite(cos) && cos >= RELATES_MIN) || shared.length >= 2) {
        edges.push({ kind: "RELATES_TO", srcKey: nk("project", slugs[i]), dstKey: nk("project", slugs[j]), weight: Number.isFinite(cos) ? cos : null, data: { sharedCaps: shared.slice(0, 12) } });
      }
    }
  }

  // ── EVALUATED + candidate nodes + FILLS (from triage history) ──
  const projIdToSlug = new Map(projects.map((p) => [p.id, p.slug]));
  const events = await db
    .select({
      repoId: schema.triageEvents.repoId, projectId: schema.triageEvents.projectId,
      verdict: schema.triageEvents.verdict, score: schema.triageEvents.score,
      effortBand: schema.triageEvents.effortBand, oneLine: schema.triageEvents.oneLine,
      reasonCode: schema.triageEvents.reasonCode, matchedFacet: schema.triageEvents.matchedFacet,
      createdAt: schema.triageEvents.createdAt, id: schema.triageEvents.id,
    })
    .from(schema.triageEvents)
    .where(eq(schema.triageEvents.userId, userId));
  // latest verdict per (project, repo)
  const latestEval = new Map<string, typeof events[number]>();
  const repoIds = new Set<number>();
  for (const e of events) {
    repoIds.add(e.repoId);
    const slug = e.projectId != null ? projIdToSlug.get(e.projectId) : null;
    const pkey = slug ?? "__global__";
    const k = `${pkey} ${e.repoId}`;
    const prev = latestEval.get(k);
    const at = e.createdAt?.getTime() ?? 0;
    if (!prev || at > (prev.createdAt?.getTime() ?? 0) || (at === (prev.createdAt?.getTime() ?? 0) && e.id > prev.id)) latestEval.set(k, e);
  }
  // Generative-skip insights (lesson/boundary) — load now so the candidate
  // repos that prompted them resolve alongside the triaged ones below.
  const insights = await db.select().from(schema.triageInsights)
    .where(eq(schema.triageInsights.userId, userId));
  for (const ins of insights) if (ins.viaCandidateRepoId != null) repoIds.add(ins.viaCandidateRepoId);
  // resolve repo owner/name for candidate node keys
  const repoRows = repoIds.size
    ? await db.select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name, stars: schema.repos.stars, url: schema.repos.url })
        .from(schema.repos)
    : [];
  const repoById = new Map(repoRows.filter((r) => repoIds.has(r.id)).map((r) => [r.id, r]));
  for (const [, e] of latestEval) {
    const repo = repoById.get(e.repoId);
    if (!repo) continue;
    const candKey = `${repo.owner}/${repo.name}`.toLowerCase();
    addNode({ kind: "candidate", nodeKey: candKey, label: `${repo.owner}/${repo.name}`, data: { fullName: `${repo.owner}/${repo.name}`, stars: repo.stars, url: repo.url } });
    const slug = e.projectId != null ? projIdToSlug.get(e.projectId) : null;
    if (slug) {
      edges.push({
        kind: "EVALUATED", srcKey: nk("project", slug), dstKey: nk("candidate", candKey), weight: e.score ?? null,
        data: { verdict: e.verdict, reasonCode: e.reasonCode, score: e.score, effort: e.effortBand, oneLine: e.oneLine, at: e.createdAt?.toISOString() ?? null },
      });
    }
    if (e.matchedFacet) {
      const capKey = norm(e.matchedFacet);
      if (capKey && nodes.has(nk("capability", capKey))) edges.push({ kind: "FILLS", srcKey: nk("candidate", candKey), dstKey: nk("capability", capKey), weight: null, data: {} });
    }
  }

  // ── LESSON / BOUNDARY nodes (generative-skip insights) ──
  // replen_capture_insight records transferable lessons + sharpened boundaries
  // during triage. They were write-only until now; surface them as their own
  // nodes, anchored to the project they touch and the candidate that prompted
  // them, so the "skipped the repo but kept the idea" lane is legible in Atlas.
  for (const ins of insights) {
    const kind = ins.kind === "boundary" ? "boundary" : "lesson";
    const key = `insight-${ins.id}`;
    addNode({ kind, nodeKey: key, label: ins.text.slice(0, 80), data: { id: ins.id, kind, text: ins.text, createdAt: ins.createdAt.toISOString() } });
    const slug = ins.appliesToProjectId != null ? projIdToSlug.get(ins.appliesToProjectId) : null;
    if (slug && projects.some((p) => p.slug === slug)) {
      edges.push({ kind: "INSIGHT_FOR", srcKey: nk("project", slug), dstKey: nk(kind, key), weight: null, data: {} });
    }
    if (ins.viaCandidateRepoId != null) {
      const repo = repoById.get(ins.viaCandidateRepoId);
      if (repo) {
        const candKey = `${repo.owner}/${repo.name}`.toLowerCase();
        if (!nodes.has(nk("candidate", candKey))) {
          addNode({ kind: "candidate", nodeKey: candKey, label: `${repo.owner}/${repo.name}`, data: { fullName: `${repo.owner}/${repo.name}`, stars: repo.stars, url: repo.url } });
        }
        edges.push({ kind: "FROM_CANDIDATE", srcKey: nk(kind, key), dstKey: nk("candidate", candKey), weight: null, data: {} });
      }
    }
  }

  // ── SUGGESTED (surfaced by Replen, not yet triaged) ──
  // Repos the inventory has SHOWN for a project that have no verdict yet —
  // on the graph in their own kind so the user can see what's on the table,
  // with a PROJECTED action level from deterministic signals (language fit,
  // licence). After triage they graduate to candidate nodes with a verdict.
  const SUGGEST_WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_GRAPH_SUGGEST_DAYS ?? "30", 10) || 30);
  const suggestStates = await db.select().from(schema.userMatchState)
    .where(eq(schema.userMatchState.userId, userId));
  const triagedRepoIds = new Set(events.map((e) => e.repoId));
  const suggestCutoff = Date.now() - SUGGEST_WINDOW_DAYS * 86400e3;
  const projLangs = new Map<string, Set<string>>();
  for (const p of projects) {
    const langs = new Set<string>();
    try {
      const s = p.summaryJson ? JSON.parse(p.summaryJson) : null;
      for (const l of (s?.languageSignals?.detected ?? []) as unknown[]) if (typeof l === "string") langs.add(l.toLowerCase());
    } catch { /* */ }
    projLangs.set(p.slug, langs);
  }
  const eligibleSuggests = suggestStates.filter((s) => {
    if (s.status !== "surfaced" && s.status !== "starred") return false;
    if (s.projectId == null || triagedRepoIds.has(s.repoId)) return false;
    const at = (s.surfacedAt ?? s.actionAt)?.getTime() ?? 0;
    return at >= suggestCutoff;
  });
  if (eligibleSuggests.length) {
    const sRepoRows = await db.select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name, stars: schema.repos.stars, url: schema.repos.url, license: schema.repos.license, primaryLanguage: schema.repos.primaryLanguage })
      .from(schema.repos);
    const sRepoById = new Map(sRepoRows.map((r) => [r.id, r]));
    const perProject = new Map<string, number>();
    let total = 0;
    for (const s of eligibleSuggests) {
      if (total >= 40) break;
      const repo = sRepoById.get(s.repoId);
      const slug = projIdToSlug.get(s.projectId!);
      if (!repo || !slug) continue;
      if ((perProject.get(slug) ?? 0) >= 6) continue;
      perProject.set(slug, (perProject.get(slug) ?? 0) + 1);
      total++;
      const fullName = `${repo.owner}/${repo.name}`;
      const lang = repo.primaryLanguage?.toLowerCase() ?? null;
      const copyleft = !!repo.license && /^(agpl|gpl|sspl)/i.test(repo.license) && !/^lgpl/i.test(repo.license);
      const langs = projLangs.get(slug) ?? new Set<string>();
      const projected = copyleft ? "clean-room build"
        : lang && langs.has(lang) ? "use as-is"
        : lang ? "port"
        : "cherry-pick";
      addNode({
        kind: "suggestion", nodeKey: fullName.toLowerCase(), label: fullName,
        data: { fullName, stars: repo.stars, url: repo.url, projected, starred: s.status === "starred" },
      });
      edges.push({
        kind: "SUGGESTED", srcKey: nk("project", slug), dstKey: nk("suggestion", fullName.toLowerCase()),
        weight: null, data: { status: s.status, projected },
      });
    }
  }

  // ── GOALS (what the user WANTS to build) ──
  // Active goals render as their own node kind, attached to their project
  // when scoped (portfolio-wide goals stand alone). The matcher and the
  // scouted searches consume the same rows directly.
  const goalRows = await db.select().from(schema.capabilityGoals)
    .where(and(eq(schema.capabilityGoals.userId, userId), eq(schema.capabilityGoals.status, "active")));
  for (const g of goalRows) {
    const gKey = `goal-${g.id}`;
    addNode({
      kind: "goal", nodeKey: gKey, label: g.label,
      data: { goalId: g.id, label: g.label, descriptor: g.descriptor, projectSlug: g.projectSlug, createdAt: g.createdAt.toISOString() },
    });
    if (g.projectSlug && projects.some((p) => p.slug === g.projectSlug)) {
      edges.push({ kind: "GOAL_OF", srcKey: nk("project", g.projectSlug), dstKey: nk("goal", gKey), weight: null, data: {} });
    }
  }

  // ── DOMAIN nodes + IN_DOMAIN edges (the dense tag cloud → patterns) ──
  // The per-project domain tag cloud (replen_set_tags) is the richest sector
  // signal we collect, and it was feeding only the centroid + pre-filter, never
  // the graph. Turn it into nodes so cross-repo patterns surface ("these 5 are
  // all UK-property"). A tag becomes a node when ≥2 of THIS user's projects
  // share it (an intra-user cluster) OR it's a common sector across ≥K distinct
  // users (the k-anon cross-user signal, gated like the catalogue). The
  // cross-user user-count is decorative (attached to node data) and deliberately
  // kept OUT of the rebuild hash so another user re-tagging never churns this
  // graph. Capped to stay lean.
  const MIN_DOMAIN_USERS = Math.max(2, parseInt(process.env.REPLEN_CATALOGUE_MIN_USERS ?? "2", 10) || 2);
  const DOMAIN_NODE_CAP = Math.max(10, parseInt(process.env.REPLEN_GRAPH_DOMAIN_CAP ?? "80", 10) || 80);
  const parseTags = (raw: string | null): string[] => {
    try { const a = JSON.parse(raw ?? "[]"); return Array.isArray(a) ? a.filter((t): t is string => typeof t === "string") : []; }
    catch { return []; }
  };
  const domainProjects = new Map<string, Set<string>>(); // tag → this user's slugs
  for (const p of projects) {
    for (const t of parseTags(p.tags)) {
      const tag = t.trim().toLowerCase();
      if (!tag) continue;
      const s = domainProjects.get(tag) ?? new Set<string>();
      s.add(p.slug); domainProjects.set(tag, s);
    }
  }
  // Cross-user distinct-user count per domain tag (non-test users), k-anon gated.
  const crossUserDomain = new Map<string, number>();
  {
    const allTagRows = await db
      .select({ userId: schema.projectProfiles.userId, tags: schema.projectProfiles.tags, role: schema.users.role })
      .from(schema.projectProfiles)
      .leftJoin(schema.users, eq(schema.projectProfiles.userId, schema.users.id))
      .where(eq(schema.projectProfiles.active, true));
    const tagUsers = new Map<string, Set<number>>();
    for (const r of allTagRows) {
      if (r.role === "test" || r.userId == null) continue;
      for (const t of parseTags(r.tags)) {
        const tag = t.trim().toLowerCase(); if (!tag) continue;
        const s = tagUsers.get(tag) ?? new Set<number>(); s.add(r.userId); tagUsers.set(tag, s);
      }
    }
    for (const [tag, users] of tagUsers) if (users.size >= MIN_DOMAIN_USERS) crossUserDomain.set(tag, users.size);
  }
  const domainNodes = [...domainProjects.entries()]
    .filter(([tag, slugs]) => slugs.size >= 2 || crossUserDomain.has(tag))
    .sort((a, b) => (b[1].size - a[1].size) || ((crossUserDomain.get(b[0]) ?? 0) - (crossUserDomain.get(a[0]) ?? 0)))
    .slice(0, DOMAIN_NODE_CAP);
  for (const [tag, slugs] of domainNodes) {
    const crossUsers = crossUserDomain.get(tag);
    addNode({ kind: "domain", nodeKey: tag, label: tag, data: { tag, projectCount: slugs.size, ...(crossUsers ? { crossUserUsers: crossUsers } : {}) } });
    for (const slug of slugs) edges.push({ kind: "IN_DOMAIN", srcKey: nk("project", slug), dstKey: nk("domain", tag), weight: null, data: {} });
  }

  // ── domain clustering: RELATED_DOMAIN edges + themes ──
  // Synonyms and sub-concepts of one real-world field (drones / uav / uas / px4
  // / mavlink / ardupilot) co-occur on the same repos but were scattered, flat
  // nodes. Link domains that share ≥2 projects (top-K each) so the field reads
  // as one connected cluster, and run Louvain to give each cluster a theme name.
  {
    const dKeys = domainNodes.map(([tag]) => tag);
    const dSlugs = new Map(domainNodes.map(([tag, s]) => [tag, s] as const));
    const dCooc: Array<{ a: string; b: string; w: number }> = [];
    for (let i = 0; i < dKeys.length; i++) {
      const ai = dSlugs.get(dKeys[i])!;
      const neigh: Array<{ k: string; w: number }> = [];
      for (let jx = 0; jx < dKeys.length; jx++) {
        if (i === jx) continue;
        const bj = dSlugs.get(dKeys[jx])!;
        let shared = 0; for (const s of ai) if (bj.has(s)) shared++;
        if (shared >= 2) neigh.push({ k: dKeys[jx], w: shared });
      }
      neigh.sort((x, y) => y.w - x.w);
      for (const { k, w } of neigh.slice(0, 6)) {
        if (dKeys[i] < k) {
          edges.push({ kind: "RELATED_DOMAIN", srcKey: nk("domain", dKeys[i]), dstKey: nk("domain", k), weight: w, data: { sharedProjects: w } });
          dCooc.push({ a: dKeys[i], b: k, w });
        }
      }
    }
    if (dKeys.length) {
      const didx = new Map<string, number>(); dKeys.forEach((k, i) => didx.set(k, i));
      const dEdges = dCooc.map((e) => ({ a: didx.get(e.a)!, b: didx.get(e.b)!, w: e.w }));
      const dcomm = louvain(dKeys.map((_, i) => i), dEdges);
      const members = new Map<number, string[]>();
      dKeys.forEach((k, i) => { const c = dcomm.get(i)!; (members.get(c) ?? members.set(c, []).get(c)!).push(k); });
      const themeName = new Map<number, string>();
      for (const [c, ms] of members) {
        const ranked = ms.slice().sort((x, y) => (dSlugs.get(y)!.size - dSlugs.get(x)!.size));
        themeName.set(c, ranked.slice(0, 2).join(" / "));
      }
      dKeys.forEach((k, i) => {
        const node = nodes.get(nk("domain", k));
        const c = dcomm.get(i);
        if (node && c != null) { node.data.theme = `d${c}`; node.data.themeName = themeName.get(c) ?? null; }
      });
    }
  }

  // ── content hash (rebuild only when inputs changed) ──
  const hashInput = JSON.stringify({
    p: projects.map((p) => [p.slug, p.facetEmbeddings ? sha256(p.facetEmbeddings) : null, p.embeddingContentHash, p.productKey, p.depVersions ? sha256(p.depVersions) : null, p.techSummary ? sha256(p.techSummary) : null]).sort(),
    e: [...latestEval.values()].map((e) => [e.id, e.verdict, e.reasonCode]).sort(),
    s: eligibleSuggests.map((s) => [s.repoId, s.projectId, s.status]).sort(),
    c: curations.map((c) => [c.normLabel, c.action, c.target]).sort(),
    t: toolPrefRows.map((t) => [t.tool, t.plan, t.migrateOff]).sort(),
    g: goalRows.map((g) => [g.id, g.label, g.projectSlug]).sort(),
    // Intra-user domain structure only — cross-user counts are excluded so
    // another user re-tagging can't churn this graph.
    d: [...domainProjects].filter(([, s]) => s.size >= 2).map(([tag, s]) => [tag, s.size]).sort(),
    i: insights.map((x) => [x.id, x.kind, x.appliesToProjectId, x.viaCandidateRepoId]).sort(),
  });
  const hash = sha256(hashInput);

  const meta = await db.select().from(schema.userGraphMeta).where(eq(schema.userGraphMeta.userId, userId)).get();
  if (!opts.force && meta?.contentHash === hash) {
    return { built: false, nodeCount: meta.nodeCount, edgeCount: meta.edgeCount, hash, reason: "unchanged" };
  }

  // ── persist atomically: wipe + reinsert ──
  const now = new Date();
  await db.delete(schema.graphEdges).where(eq(schema.graphEdges.userId, userId));
  await db.delete(schema.graphNodes).where(eq(schema.graphNodes.userId, userId));

  const keyToId = new Map<string, number>();
  for (const n of nodes.values()) {
    const ins = await db.insert(schema.graphNodes)
      .values({ userId, kind: n.kind, nodeKey: n.nodeKey, label: n.label, data: JSON.stringify(n.data), updatedAt: now })
      .returning({ id: schema.graphNodes.id }).get();
    keyToId.set(nk(n.kind, n.nodeKey), ins.id);
  }
  let edgeCount = 0;
  for (const e of edges) {
    const src = keyToId.get(e.srcKey); const dst = keyToId.get(e.dstKey);
    if (src == null || dst == null) continue;
    await db.insert(schema.graphEdges).values({ userId, kind: e.kind, srcId: src, dstId: dst, weight: e.weight, data: JSON.stringify(e.data), updatedAt: now });
    edgeCount++;
  }

  const nodeCount = keyToId.size;
  await db.insert(schema.userGraphMeta)
    .values({ userId, contentHash: hash, nodeCount, edgeCount, builtAt: now })
    .onConflictDoUpdate({ target: schema.userGraphMeta.userId, set: { contentHash: hash, nodeCount, edgeCount, builtAt: now } });

  return { built: true, nodeCount, edgeCount, hash, reason: opts.force ? "forced" : "changed" };
}
