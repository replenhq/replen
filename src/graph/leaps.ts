// Atlas §1 — Leaps. The non-obvious, high-leverage connection engine. A cosine
// matcher can't see these; the graph can. Three generators over the per-user
// Atlas graph, each scored by relevance × novelty × bridge-bonus and explained
// with the PATH that makes it land (Graphify's "what connects A to B").
//
//   1. cross-project transfer — you solved X in project A; B is closely related
//      and doesn't have X. Points at the repo A adopted/ported, or A's approach.
//      (graph-only; the most unique and valuable signal)
//   2. adjacency leap — a capability ADJACENT to one you have but genuinely
//      distinct (not a synonym), with the best catalogue repo that fills it.
//   3. cross-user endorsement — a repo that scored adopt/port across ≥K other
//      users whose projects look like yours, that you haven't evaluated. k-anon.
//   4. vault-bridge — hops the user's OWN wikilinks (concept→concept) from a
//      capability they have to a related one they don't, pointing at the repo
//      another of their projects adopted for it (or a catalogue fill). The one
//      generator that rides the user's asserted graph, not embedding cosine.

import { eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { cosineSimilarity, parseStoredEmbedding } from "../lib/embeddings";
import { KEEP_KINDS, type RepoKind } from "../catalogue/classify";
import { isGloballyDemoted } from "../lib/repo-quality";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// A "leap" must be DISTINCT, not a synonym of something you already have. The
// graph's ADJACENT_TO band tops out at 0.88 (near-dups); a real leap sits below.
const LEAP_ADJ_MAX = Math.min(1, parseFloat(process.env.REPLEN_LEAP_ADJ_MAX ?? "0.82"));
const LEAP_ADJ_MIN = Math.max(0, parseFloat(process.env.REPLEN_LEAP_ADJ_MIN ?? "0.50"));
const CROSS_PROJECT_BONUS = Math.max(0, parseFloat(process.env.REPLEN_LEAP_XPROJ_BONUS ?? "0.6"));
// Cross-project transfer needs DISTINCT-but-related projects. Above this, two
// "projects" are really the same thing (a fork / a re-registration), so every
// shared capability "transfers" — pure noise. Below RELATES_MIN they're unrelated.
const LEAP_RELATES_MAX = Math.min(1, parseFloat(process.env.REPLEN_LEAP_RELATES_MAX ?? "0.85"));
const LEAP_RELATES_MIN = Math.max(0, parseFloat(process.env.REPLEN_LEAP_RELATES_MIN ?? "0.55"));
// A leap that points at a repo you actually adopted/ported elsewhere is far more
// actionable than "use your own approach" — rank it up.
const CANDIDATE_BACKED_MULT = Math.max(1, parseFloat(process.env.REPLEN_LEAP_CAND_MULT ?? "1.5"));
const CROSS_USER_BONUS = Math.max(0, parseFloat(process.env.REPLEN_LEAP_XUSER_BONUS ?? "0.4"));
const CROSS_USER_K = Math.max(2, parseInt(process.env.REPLEN_LEAP_XUSER_K ?? "3", 10) || 3);
const XUSER_SIM_MIN = Math.max(0, parseFloat(process.env.REPLEN_LEAP_XUSER_SIM ?? "0.55"));
const PROVENANCE_W: Record<string, number> = { grounded: 1.0, extracted: 0.9, inferred: 0.75, ambiguous: 0.4 };
// Trust weight for vault-bridge leaps. VAULT_LINK carries an ASSERTED relation
// with no embedding similarity, so it gets its own base weight (not the cosine
// LEAP_ADJ band). Kept modest so cosine-grounded leaps still rank above it.
const LEAP_VAULT_W = Math.max(0, parseFloat(process.env.REPLEN_LEAP_VAULT_W ?? "0.7"));
// Cap vault leaps per project so a densely-wikilinked vault can't flood the
// queue (calm-cadence contract: 1-3 actionable matches/project/month).
const LEAP_VAULT_PER_PROJECT = Math.max(1, parseInt(process.env.REPLEN_LEAP_VAULT_CAP ?? "2", 10) || 2);

export type Leap = {
  kind: "cross-project" | "adjacency" | "cross-user" | "vault";
  forProject: string;        // slug the leap is for
  capability: string;        // capability at the heart of the leap
  candidate: string | null;  // owner/name to bring in (null = use your own approach)
  url: string | null;
  stars: number | null;
  sourceProject: string | null; // for cross-project: where you already solved it
  usersEndorsed: number | null;  // for cross-user
  via: string;               // the path explanation
  score: number;
};

type GNode = { id: number; kind: string; nodeKey: string; label: string; data: Record<string, unknown> };
type GEdge = { kind: string; srcId: number; dstId: number; weight: number | null; data: Record<string, unknown> };

export async function computeLeaps(userId: number, opts: { scopeProject?: string; limit?: number } = {}): Promise<Leap[]> {
  const limit = opts.limit ?? 12;
  const rawNodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.userId, userId));
  const rawEdges = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.userId, userId));
  if (rawNodes.length === 0) return [];

  const nodes: GNode[] = rawNodes.map((n) => ({ id: n.id, kind: n.kind, nodeKey: n.nodeKey, label: n.label, data: safeJson(n.data) }));
  const edges: GEdge[] = rawEdges.map((e) => ({ kind: e.kind, srcId: e.srcId, dstId: e.dstId, weight: e.weight, data: safeJson(e.data) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ── index the graph ──
  const projectIdBySlug = new Map<string, number>();
  for (const n of nodes) if (n.kind === "project") projectIdBySlug.set(n.nodeKey, n.id);
  const projHasCap = new Map<number, Map<number, { provenance: string; paths: string[] }>>(); // projId → capId → meta
  const capById = new Map<number, GNode>();
  for (const n of nodes) if (n.kind === "capability") capById.set(n.id, n);
  for (const e of edges) {
    if (e.kind === "HAS_CAPABILITY") {
      const m = projHasCap.get(e.srcId) ?? new Map();
      m.set(e.dstId, { provenance: String(e.data.provenance ?? "inferred"), paths: Array.isArray(e.data.paths) ? (e.data.paths as string[]) : [] });
      projHasCap.set(e.srcId, m);
    }
  }
  const capHasProj = new Map<number, Set<number>>(); // capId → projIds
  for (const [pid, caps] of projHasCap) for (const cid of caps.keys()) { const s = capHasProj.get(cid) ?? new Set(); s.add(pid); capHasProj.set(cid, s); }
  // adjacency (undirected) with weight
  const adj = new Map<number, Array<{ cap: number; w: number }>>();
  for (const e of edges) if (e.kind === "ADJACENT_TO" && e.weight != null) {
    (adj.get(e.srcId) ?? adj.set(e.srcId, []).get(e.srcId)!).push({ cap: e.dstId, w: e.weight });
    (adj.get(e.dstId) ?? adj.set(e.dstId, []).get(e.dstId)!).push({ cap: e.srcId, w: e.weight });
  }
  // related projects
  const related: Array<{ a: number; b: number; w: number }> = [];
  for (const e of edges) if (e.kind === "RELATES_TO") related.push({ a: e.srcId, b: e.dstId, w: e.weight ?? 0 });
  // project → product (siblings of one product are deliberately split concerns;
  // transferring a capability between them is noise — the product already has it).
  const projProduct = new Map<number, number>();
  for (const e of edges) if (e.kind === "MEMBER_OF") projProduct.set(e.srcId, e.dstId);
  const sameProduct = (x: number, y: number) => projProduct.has(x) && projProduct.get(x) === projProduct.get(y);
  // what each project evaluated positively, by capability it fills
  const candNodeById = new Map<number, GNode>();
  for (const n of nodes) if (n.kind === "candidate") candNodeById.set(n.id, n);
  const fills = new Map<number, Set<number>>(); // candidateId → capIds
  for (const e of edges) if (e.kind === "FILLS") { const s = fills.get(e.srcId) ?? new Set(); s.add(e.dstId); fills.set(e.srcId, s); }
  const projAdopted = new Map<number, Array<{ cand: number; verdict: string }>>(); // projId → evaluated candidates
  const evaluatedFullNames = new Set<string>();
  for (const e of edges) if (e.kind === "EVALUATED") {
    const verdict = String(e.data.verdict ?? "");
    const cand = candNodeById.get(e.dstId);
    if (cand) evaluatedFullNames.add(norm(String(cand.data.fullName ?? cand.label)));
    if (verdict === "adopt" || verdict === "port") { const a = projAdopted.get(e.srcId) ?? []; a.push({ cand: e.dstId, verdict }); projAdopted.set(e.srcId, a); }
  }
  // vault concept layer (goal b): GROUNDS (concept→capability) + VAULT_LINK
  // (concept↔concept). Indexed with their OWN trust weight, NOT the cosine
  // adjacency band — these are the user's asserted relations.
  const conceptGroundsCap = new Map<number, Set<number>>(); // conceptId → capIds
  const capGroundedBy = new Map<number, Set<number>>();      // capId → conceptIds
  for (const e of edges) if (e.kind === "GROUNDS") {
    (conceptGroundsCap.get(e.srcId) ?? conceptGroundsCap.set(e.srcId, new Set()).get(e.srcId)!).add(e.dstId);
    (capGroundedBy.get(e.dstId) ?? capGroundedBy.set(e.dstId, new Set()).get(e.dstId)!).add(e.srcId);
  }
  const conceptLinks = new Map<number, Array<{ concept: number; rel?: string }>>(); // undirected
  for (const e of edges) if (e.kind === "VAULT_LINK") {
    const rel = typeof e.data.rel === "string" ? e.data.rel : undefined;
    (conceptLinks.get(e.srcId) ?? conceptLinks.set(e.srcId, []).get(e.srcId)!).push({ concept: e.dstId, rel });
    (conceptLinks.get(e.dstId) ?? conceptLinks.set(e.dstId, []).get(e.dstId)!).push({ concept: e.srcId, rel });
  }

  // Prebuild the catalogue capability index ONCE. This used to be a full
  // catalogueRepos scan + JSON parse per wanted capability per project, which
  // made the portfolio-wide path (every project) time out. One pass now.
  const catByCap = await buildCatalogueCapIndex(evaluatedFullNames);
  // Prebuild every project's facet vectors ONCE (was one query per project).
  const facetVecsBySlug = await allProjectFacetVecs(userId);

  const scopeId = opts.scopeProject ? projectIdBySlug.get(opts.scopeProject) ?? null : null;
  const projectIds = scopeId != null ? [scopeId] : [...projectIdBySlug.values()];
  const slugOf = (id: number) => byId.get(id)?.nodeKey ?? "?";

  const leaps: Leap[] = [];
  const seen = new Set<string>(); // forProject + candidate/cap dedup

  // is capability `cid` a near-synonym of any capability the project has?
  const isSynonymOfProject = (cid: number, projCaps: Map<number, unknown>): boolean => {
    if (projCaps.has(cid)) return true;
    for (const { cap, w } of adj.get(cid) ?? []) if (w > LEAP_ADJ_MAX && projCaps.has(cap)) return true;
    return false;
  };

  // ── Generator 1: cross-project transfer (graph-only) ──
  for (const { a, b, w } of related) {
    if (w < LEAP_RELATES_MIN || w > LEAP_RELATES_MAX) continue; // skip unrelated + near-duplicate projects
    if (sameProduct(a, b)) continue; // siblings of one product — not a transfer
    for (const [src, dst] of [[a, b], [b, a]] as const) {
      const srcCaps = projHasCap.get(src); const dstCaps = projHasCap.get(dst);
      if (!srcCaps) continue;
      if (scopeId != null && dst !== scopeId) continue;
      for (const [capId, meta] of srcCaps) {
        if (dstCaps && isSynonymOfProject(capId, dstCaps)) continue; // dst already has it (or a synonym)
        if (meta.provenance === "ambiguous") continue; // don't transfer noise
        const cap = capById.get(capId); if (!cap) continue;
        // what did src adopt/port that fills this capability?
        const adoptedHere = (projAdopted.get(src) ?? []).find((x) => fills.get(x.cand)?.has(capId));
        const candNode = adoptedHere ? candNodeById.get(adoptedHere.cand) : null;
        const key = `xp:${dst}:${candNode ? candNode.nodeKey : capId}`;
        if (seen.has(key)) continue; seen.add(key);
        // Evidence anchor: when the source project recorded WHERE the
        // capability lives, the leap points straight at the file to port.
        const anchor = meta.paths.length ? ` (see ${slugOf(src)}: ${meta.paths[0]})` : "";
        const via = candNode
          ? `you ${adoptedHere!.verdict}ed ${candNode.label} for ${cap.label} in ${slugOf(src)}; ${slugOf(dst)} is closely related and doesn't have ${cap.label} yet`
          : `you use ${cap.label} in ${slugOf(src)}${anchor}; ${slugOf(dst)} is closely related and could too`;
        leaps.push({
          kind: "cross-project", forProject: slugOf(dst), capability: cap.label,
          candidate: candNode ? String(candNode.data.fullName ?? candNode.label) : null,
          url: candNode ? (candNode.data.url as string ?? null) : null,
          stars: candNode ? (candNode.data.stars as number ?? null) : null,
          sourceProject: slugOf(src), usersEndorsed: null, via,
          score: w * (PROVENANCE_W[meta.provenance] ?? 0.75) * (1 + CROSS_PROJECT_BONUS) * (candNode ? CANDIDATE_BACKED_MULT : 1),
        });
      }
    }
  }

  // ── Generator 2: adjacency leap (graph + catalogue) ──
  for (const pid of projectIds) {
    const pcaps = projHasCap.get(pid); if (!pcaps) continue;
    const wantCaps = new Map<number, { fromLabel: string; w: number }>(); // adjacent cap → best path
    for (const capId of pcaps.keys()) {
      const fromLabel = capById.get(capId)?.label ?? "";
      for (const { cap: y, w } of adj.get(capId) ?? []) {
        if (w < LEAP_ADJ_MIN || w > LEAP_ADJ_MAX) continue;
        if (isSynonymOfProject(y, pcaps)) continue;
        const prev = wantCaps.get(y);
        if (!prev || w > prev.w) wantCaps.set(y, { fromLabel, w });
      }
    }
    for (const [yId, { fromLabel, w }] of wantCaps) {
      const yLabel = capById.get(yId)?.label; if (!yLabel) continue;
      const cand = catByCap.get(yLabel.toLowerCase());
      if (!cand) continue;
      const key = `adj:${pid}:${norm(cand.fullName)}`;
      if (seen.has(key)) continue; seen.add(key);
      leaps.push({
        kind: "adjacency", forProject: slugOf(pid), capability: yLabel, candidate: cand.fullName,
        url: cand.url, stars: cand.stars, sourceProject: null, usersEndorsed: null,
        via: `adjacent to your ${fromLabel} — you don't use ${yLabel} yet; ${cand.fullName} fills it`,
        score: w * 0.9,
      });
    }
  }

  // ── Generator 3: cross-user endorsement (repo_quality + catalogue, k-anon) ──
  const endorsed = await endorsedCandidates(); // [{fullName, embedding, users, url, stars}]
  if (endorsed.length) {
    for (const pid of projectIds) {
      const slug = slugOf(pid);
      const projRow = facetVecsBySlug.get(slug) ?? [];
      if (!projRow.length) continue;
      for (const cand of endorsed) {
        if (evaluatedFullNames.has(norm(cand.fullName))) continue;
        // similar to one of this project's capabilities?
        let best = -Infinity;
        for (const v of projRow) { const c = cosineSimilarity(v, cand.embedding); if (c > best) best = c; }
        if (best < XUSER_SIM_MIN) continue;
        const key = `xu:${pid}:${norm(cand.fullName)}`;
        if (seen.has(key)) continue; seen.add(key);
        leaps.push({
          kind: "cross-user", forProject: slug, capability: "", candidate: cand.fullName,
          url: cand.url, stars: cand.stars, sourceProject: null, usersEndorsed: cand.users,
          via: `${cand.users} projects like yours kept ${cand.fullName} (adopted or ported) — you haven't looked at it`,
          score: best * (1 + CROSS_USER_BONUS),
        });
      }
    }
  }

  // ── Generator 4: vault-bridge (graph-only; hops the user's OWN wikilinks) ──
  // The vault asserts concept↔concept relations a cosine matcher can't see.
  // Path: project P has cap K → concept(s) grounding K → VAULT_LINK neighbour
  // concept C' → cap K' that C' grounds (and P lacks). If another project Q has
  // K', that's a transfer along the user's own structure (point at what Q
  // adopted); else fill K' from the catalogue. `same-as` links are skipped (that
  // collapses into one capability at build time — it's not a bridge to a new one).
  for (const pid of projectIds) {
    const pcaps = projHasCap.get(pid); if (!pcaps) continue;
    // capId(K) → kPrimeId(K') → the wikilink path that bridged them
    const bridged = new Map<number, Map<number, { fromConcept: string; toConcept: string; rel?: string }>>();
    for (const capId of pcaps.keys()) {
      for (const conceptId of capGroundedBy.get(capId) ?? []) {
        const fromConcept = byId.get(conceptId)?.label ?? "";
        for (const { concept: c2, rel } of conceptLinks.get(conceptId) ?? []) {
          if (rel === "same-as") continue;
          const toConcept = byId.get(c2)?.label ?? "";
          for (const kPrime of conceptGroundsCap.get(c2) ?? []) {
            if (kPrime === capId || isSynonymOfProject(kPrime, pcaps)) continue;
            const m = bridged.get(capId) ?? bridged.set(capId, new Map()).get(capId)!;
            if (!m.has(kPrime)) m.set(kPrime, { fromConcept, toConcept, rel });
          }
        }
      }
    }
    for (const [capId, kPrimes] of bridged) {
      const kLabel = capById.get(capId)?.label ?? "";
      for (const [kPrimeId, path] of kPrimes) {
        const kPrime = capById.get(kPrimeId); if (!kPrime) continue;
        // Another of the user's projects that has K' (point at what it adopted)?
        let donor: number | null = null;
        for (const q of capHasProj.get(kPrimeId) ?? []) {
          if (q === pid || sameProduct(pid, q)) continue;
          donor = q; break;
        }
        let candidate: string | null = null, url: string | null = null, stars: number | null = null;
        let sourceProject: string | null = null, candBacked = false;
        if (donor != null) {
          sourceProject = slugOf(donor);
          const adoptedThere = (projAdopted.get(donor) ?? []).find((x) => fills.get(x.cand)?.has(kPrimeId));
          const candNode = adoptedThere ? candNodeById.get(adoptedThere.cand) : null;
          if (candNode) { candidate = String(candNode.data.fullName ?? candNode.label); url = (candNode.data.url as string) ?? null; stars = (candNode.data.stars as number) ?? null; candBacked = true; }
        } else {
          const cat = catByCap.get(kPrime.label.toLowerCase());
          if (!cat) continue; // nothing actionable to point at
          candidate = cat.fullName; url = cat.url; stars = cat.stars;
        }
        const key = `vault:${pid}:${kPrimeId}:${candidate ? norm(candidate) : kPrimeId}`;
        if (seen.has(key)) continue; seen.add(key);
        const wikilink = path.fromConcept && path.toConcept ? `via your vault: [[${path.fromConcept}]] → [[${path.toConcept}]]; ` : "";
        const via = sourceProject
          ? `${wikilink}${kLabel} relates to ${kPrime.label}, which you ${candBacked ? "brought into" : "have in"} ${sourceProject} but ${slugOf(pid)} doesn't have`
          : `${wikilink}${kLabel} relates to ${kPrime.label} (not in ${slugOf(pid)} yet); ${candidate} fills it`;
        leaps.push({
          kind: "vault", forProject: slugOf(pid), capability: kPrime.label,
          candidate, url, stars, sourceProject, usersEndorsed: null, via,
          score: LEAP_VAULT_W * (candBacked ? CANDIDATE_BACKED_MULT : 1),
        });
      }
    }
  }

  leaps.sort((a, b) => b.score - a.score);
  // Diversify: cap per project (≤4), cap per (project, source) pair (≤2), and a
  // tighter per-project cap on vault leaps so a densely-wikilinked vault can't
  // crowd out the cosine-grounded generators.
  const perProject = new Map<string, number>();
  const perPair = new Map<string, number>();
  const perVault = new Map<string, number>();
  const out: Leap[] = [];
  for (const l of leaps) {
    const n = perProject.get(l.forProject) ?? 0;
    if (n >= 4) continue;
    if (l.kind === "vault" && (perVault.get(l.forProject) ?? 0) >= LEAP_VAULT_PER_PROJECT) continue;
    const pairKey = `${l.forProject}|${l.kind}|${l.sourceProject ?? ""}`;
    const pn = perPair.get(pairKey) ?? 0;
    if (l.kind === "cross-project" && pn >= 2) continue;
    perProject.set(l.forProject, n + 1);
    perPair.set(pairKey, pn + 1);
    if (l.kind === "vault") perVault.set(l.forProject, (perVault.get(l.forProject) ?? 0) + 1);
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}

function safeJson(s: string | null): Record<string, unknown> { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

// One pass over the catalogue → a map of capability label (lowercased) to the
// best adoptable repo that fills it (highest stars, not already evaluated).
// Replaces a per-capability full table scan; built once per computeLeaps call.
type CatHit = { fullName: string; url: string | null; stars: number | null };
async function buildCatalogueCapIndex(exclude: Set<string>): Promise<Map<string, CatHit>> {
  const rows = await db
    .select({ fullName: schema.catalogueRepos.fullName, url: schema.catalogueRepos.url, stars: schema.catalogueRepos.stars, capabilities: schema.catalogueRepos.capabilities, kind: schema.catalogueRepos.kind })
    .from(schema.catalogueRepos);
  const idx = new Map<string, CatHit>();
  for (const r of rows) {
    if (exclude.has(norm(r.fullName))) continue;
    if (r.kind && !KEEP_KINDS.has(r.kind as RepoKind)) continue;
    let caps: string[] = []; try { caps = r.capabilities ? JSON.parse(r.capabilities) : []; } catch { /* */ }
    for (const c of caps) {
      if (typeof c !== "string") continue;
      const k = c.toLowerCase();
      const prev = idx.get(k);
      if (!prev || (r.stars ?? 0) > (prev.stars ?? 0)) idx.set(k, { fullName: r.fullName, url: r.url, stars: r.stars });
    }
  }
  return idx;
}

// Candidates adopt/port-endorsed by ≥K distinct users (k-anon), joined to the
// catalogue for an embedding so we can match them to the asking user's projects.
async function endorsedCandidates(): Promise<Array<{ fullName: string; embedding: number[]; users: number; url: string | null; stars: number | null }>> {
  const q = await db
    .select({ repoId: schema.repoQuality.repoId, adopt: schema.repoQuality.adoptUsers, port: schema.repoQuality.portUsers, skip: schema.repoQuality.skipUsers, total: schema.repoQuality.totalUsers })
    .from(schema.repoQuality)
    .where(gte(schema.repoQuality.totalUsers, CROSS_USER_K));
  // Positive endorsement AND not globally demoted — a repo enough users called
  // rubbish must never resurface as a cross-user "leap" (the inventory route
  // gates this; the leap path must too).
  const positive = q.filter((r) => (r.adopt + r.port) >= CROSS_USER_K && !isGloballyDemoted({ skipUsers: r.skip, totalUsers: r.total }));
  if (!positive.length) return [];
  // One catalogue query for all endorsed repos (was one per repo).
  const repos = await db.select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name, url: schema.repos.url, stars: schema.repos.stars })
    .from(schema.repos).where(inArray(schema.repos.id, positive.map((p) => p.repoId)));
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const fullNames = repos.map((r) => `${r.owner}/${r.name}`);
  const catRows = fullNames.length
    ? await db.select({ fullName: schema.catalogueRepos.fullName, embedding: schema.catalogueRepos.embedding })
        .from(schema.catalogueRepos).where(inArray(schema.catalogueRepos.fullName, fullNames))
    : [];
  const embByName = new Map(catRows.map((c) => [c.fullName.toLowerCase(), parseStoredEmbedding(c.embedding ?? null)]));
  const out: Array<{ fullName: string; embedding: number[]; users: number; url: string | null; stars: number | null }> = [];
  for (const p of positive) {
    const r = repoById.get(p.repoId); if (!r) continue;
    const fullName = `${r.owner}/${r.name}`;
    const emb = embByName.get(fullName.toLowerCase()); if (!emb) continue;
    out.push({ fullName, embedding: emb, users: p.adopt + p.port, url: r.url, stars: r.stars });
  }
  return out;
}

// All of a user's projects' facet vectors, keyed by slug, in one query (to
// match cross-user candidates against). Was one query per project.
async function allProjectFacetVecs(userId: number): Promise<Map<string, number[][]>> {
  const rows = await db.select({ slug: schema.projectProfiles.slug, facetEmbeddings: schema.projectProfiles.facetEmbeddings })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  const m = new Map<string, number[][]>();
  for (const p of rows) {
    if (!p.facetEmbeddings) continue;
    try { const o = JSON.parse(p.facetEmbeddings) as { facets?: Array<{ vec: number[] }> }; m.set(p.slug, (o.facets ?? []).map((f) => f.vec).filter(Array.isArray)); } catch { /* */ }
  }
  return m;
}
