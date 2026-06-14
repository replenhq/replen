// Keystone read API — coverage (visibility, anti-inertness) + upgrade
// suggestions (the load-bearing query that turns the ontology into output).
import { db, schema } from "../db/client";
import { and, eq, inArray, sql } from "drizzle-orm";

// Counts per node/edge kind — surfaced in /api/healthz so Keystone's contents
// are VISIBLE. If algorithm edges read 0, you SEE it's unseeded instead of
// assuming it's working. This is the guard against "built but inert".
export async function keystoneCoverage(): Promise<{
  capabilities: number;
  solutionsByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
}> {
  const caps = await db.select({ c: sql<number>`count(*)` }).from(schema.keystoneCapabilities).get();
  const sols = await db.select({ kind: schema.keystoneSolutions.kind, c: sql<number>`count(*)` }).from(schema.keystoneSolutions).groupBy(schema.keystoneSolutions.kind);
  const edges = await db.select({ kind: schema.keystoneEdges.kind, c: sql<number>`count(*)` }).from(schema.keystoneEdges).groupBy(schema.keystoneEdges.kind);
  return {
    capabilities: caps?.c ?? 0,
    solutionsByKind: Object.fromEntries(sols.map((r) => [r.kind, r.c])),
    edgesByKind: Object.fromEntries(edges.map((r) => [r.kind, r.c])),
  };
}

export type KeystoneUpgrade = {
  current: string;     // the solution the user is on (the "loser")
  better: string;      // the recommended solution
  betterKind: string;  // library | hosted_model | service | algorithm | practice
  task: string;        // the task this comparison holds for (better is task-RELATIVE)
  margin: number | null;
  source: string | null;
};

// Given the names of solutions a project uses (dep names, reported model names),
// return Keystone `better_than` edges where the user is on the worse side. The
// task scoping is load-bearing: "better" depends on the task, so the suggestion
// always carries it (Replen's own A/B is the cautionary seed — 3-large is worse
// for short-label retrieval even though MTEB says it's better in general).
export async function suggestUpgrades(usedSolutionNames: string[]): Promise<KeystoneUpgrade[]> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = new Set(usedSolutionNames.map(norm).filter(Boolean));
  if (wanted.size === 0) return [];
  // Find the user's solutions in Keystone.
  const sols = await db.select({ id: schema.keystoneSolutions.id, name: schema.keystoneSolutions.name, normName: schema.keystoneSolutions.normName }).from(schema.keystoneSolutions);
  const mine = sols.filter((s) => wanted.has(s.normName));
  if (mine.length === 0) return [];
  const myIds = mine.map((s) => s.id);
  const byId = new Map(sols.map((s) => [s.id, s]));
  // better_than edges where one of MY solutions is the LOSER (the `to` side).
  const edges = await db.select().from(schema.keystoneEdges)
    .where(and(eq(schema.keystoneEdges.kind, "better_than"), eq(schema.keystoneEdges.toKind, "solution"), inArray(schema.keystoneEdges.toId, myIds)));
  const kindById = new Map((await db.select({ id: schema.keystoneSolutions.id, kind: schema.keystoneSolutions.kind }).from(schema.keystoneSolutions)).map((r) => [r.id, r.kind]));
  const out: KeystoneUpgrade[] = [];
  for (const e of edges) {
    const better = byId.get(e.fromId); const current = byId.get(e.toId);
    if (!better || !current) continue;
    // Already-present guard: if the recommended target is ITSELF among the
    // user's solutions (e.g. they already depend on viem alongside a stale
    // ethers), the swap is effectively done — don't suggest migrating to
    // something they're already on. Mirrors the "own dep suggested back" guard
    // the candidate path already has.
    if (wanted.has(better.normName)) continue;
    let attrs: { task?: string; margin?: number; source?: string } = {};
    try { attrs = e.attributes ? JSON.parse(e.attributes) : {}; } catch { /* */ }
    out.push({ current: current.name, better: better.name, betterKind: kindById.get(e.fromId) ?? "solution", task: attrs.task ?? "general", margin: attrs.margin ?? null, source: attrs.source ?? null });
  }
  return out;
}

// Capabilities the user already COVERS — any Keystone capability that one of
// their existing solutions (deps) `fills`. A NEW candidate matching such a
// capability is likely "covered" (the largest false-positive bucket in the triage
// eval: high-cosine repos skipped because a solution is already in place) and
// should be down-ranked / kept off the headline. Reach grows with Keystone's
// `fills` edges (workstream B) — dormant when those are sparse, never wrong.
export async function coveredCapabilities(usedSolutionNames: string[]): Promise<Set<string>> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = new Set(usedSolutionNames.map(norm).filter(Boolean));
  if (wanted.size === 0) return new Set();
  const sols = await db.select({ id: schema.keystoneSolutions.id, normName: schema.keystoneSolutions.normName }).from(schema.keystoneSolutions);
  const myIds = sols.filter((s) => wanted.has(s.normName)).map((s) => s.id);
  if (myIds.length === 0) return new Set();
  const fills = await db.select({ toId: schema.keystoneEdges.toId }).from(schema.keystoneEdges)
    .where(and(eq(schema.keystoneEdges.kind, "fills"), eq(schema.keystoneEdges.fromKind, "solution"), inArray(schema.keystoneEdges.fromId, myIds)));
  if (fills.length === 0) return new Set();
  const capIds = new Set(fills.map((f) => f.toId));
  const caps = await db.select({ id: schema.keystoneCapabilities.id, normLabel: schema.keystoneCapabilities.normLabel }).from(schema.keystoneCapabilities);
  // Re-normalize with THIS function so the caller can match a raw facet label
  // through the same norm, regardless of how the seeder stored normLabel.
  return new Set(caps.filter((c) => capIds.has(c.id)).map((c) => norm(c.normLabel)));
}

import { cosineSimilarity, parseStoredEmbedding, parseStoredFacetEmbeddings } from "./embeddings";

export type PracticeTransfer = {
  practice: string;       // the Keystone practice name
  description: string;    // what it is
  fromProject: string;    // the portfolio project that already does it (grounding)
  shapeFit: number;       // cosine(scoped project centroid, practice applicability vector)
};

// Practice-transfer (SIGNAL-based): a structural move (Keystone practice) that
// FITS THE SCOPED PROJECT'S SHAPE — measured against the practice's applicability
// vector (its signals: "many related entity stores", "fork-per-customer pressure"
// …), NOT the source project's domain — and that the scoped project doesn't yet
// make but ANOTHER portfolio project does (grounded in the user's own work:
// "acme does this, and your project looks like one that needs it"). Right
// because a practice is broadly applicable: a data-driven ontology helps any
// data-heavy multi-tenant system regardless of whether its DOMAIN resembles the
// source. A project "uses" a practice when one of its facets matches a practice
// node. Rare + high-conviction (needs a real shape-fit AND a real gap).
export async function suggestPracticeTransfer(
  userId: number,
  scopedSlug: string,
  opts: { standoutMargin?: number; topPercentile?: number } = {},
): Promise<PracticeTransfer[]> {
  // Abstract practice-text embeds in a COMPRESSED band against concrete project
  // summaries, so an absolute cosine threshold is fragile. Calibrate instead
  // (same lesson as facet matching): the scoped project fits a practice only if
  // its shape-fit STANDS OUT in the per-practice distribution — top percentile
  // AND a real margin over the portfolio median. Flat distributions (no project
  // clearly needs it) correctly stay silent.
  const standoutMargin = opts.standoutMargin ?? 0.03;
  const topPct = opts.topPercentile ?? 0.8;
  const practices = await db.select({ name: schema.keystoneSolutions.name, normName: schema.keystoneSolutions.normName, description: schema.keystoneSolutions.description, embedding: schema.keystoneSolutions.embedding })
    .from(schema.keystoneSolutions).where(eq(schema.keystoneSolutions.kind, "practice"));
  if (practices.length === 0) return [];
  const practiceByNorm = new Map(practices.map((p) => [p.normName, p]));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const projects = await db.select({ slug: schema.projectProfiles.slug, embedding: schema.projectProfiles.embedding, facets: schema.projectProfiles.facetEmbeddings, productKey: schema.projectProfiles.productKey })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true), eq(schema.projectProfiles.included, true)));
  const scoped = projects.find((p) => p.slug === scopedSlug);
  if (!scoped) return [];
  const scopedVec = parseStoredEmbedding(scoped.embedding ?? null);
  if (!scopedVec) return [];

  const usesPractices = (facets: string | null): Set<string> => {
    const out = new Set<string>();
    for (const f of parseStoredFacetEmbeddings(facets)) { const n = norm(f.label); if (practiceByNorm.has(n)) out.add(n); }
    return out;
  };
  const scopedUses = usesPractices(scoped.facets ?? null);
  const scopedProduct = scoped.productKey;

  // Practices SOME other (different-product) portfolio project makes → the
  // grounding: which project to cite. practice-norm → that project's slug.
  const groundedBy = new Map<string, string>();
  for (const p of projects) {
    if (p.slug === scopedSlug) continue;
    if (scopedProduct && p.productKey === scopedProduct) continue;
    for (const used of usesPractices(p.facets ?? null)) if (!groundedBy.has(used)) groundedBy.set(used, p.slug);
  }

  // Precompute each project's centroid + product once.
  const projVecs = projects.map((p) => ({ slug: p.slug, productKey: p.productKey, vec: parseStoredEmbedding(p.embedding ?? null), usesAny: usesPractices(p.facets ?? null) }))
    .filter((x): x is { slug: string; productKey: string | null; vec: number[]; usesAny: Set<string> } => x.vec !== null);

  const out: PracticeTransfer[] = [];
  for (const [normName, fromProject] of groundedBy) {
    if (scopedUses.has(normName)) continue; // scoped already does it
    const pr = practiceByNorm.get(normName)!;
    const appVec = parseStoredEmbedding(pr.embedding ?? null);
    if (!appVec) continue;
    // Calibrate over the CANDIDATE pool only — projects that DON'T already make
    // this practice (and aren't in a product that does). Including the source
    // product would crowd the top percentile with projects that score high
    // precisely because the practice came from them, hiding genuine candidates.
    const usingProducts = new Set(projVecs.filter((p) => p.usesAny.has(normName) && p.productKey).map((p) => p.productKey));
    const candidates = projVecs.filter((p) => !p.usesAny.has(normName) && !(p.productKey && usingProducts.has(p.productKey)));
    const fits = candidates.map((p) => ({ slug: p.slug, fit: cosineSimilarity(p.vec, appVec) })).filter((x) => Number.isFinite(x.fit));
    if (fits.length < 4) continue; // too few to calibrate
    const scopedFit = fits.find((f) => f.slug === scopedSlug)?.fit;
    if (scopedFit === undefined) continue;
    const sorted = fits.map((f) => f.fit).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const topBar = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * topPct))];
    // STANDOUT: in the top percentile AND a real margin above the portfolio median.
    if (scopedFit >= topBar && scopedFit - median >= standoutMargin) {
      out.push({ practice: pr.name, description: pr.description ?? "", fromProject, shapeFit: scopedFit });
    }
  }
  return out.sort((a, b) => b.shapeFit - a.shapeFit);
}
