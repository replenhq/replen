// Atlas §2 — Recall. The in-session memory. The agent asks "what have we decided
// about X? what have we ported? have we seen this repo?" and gets answers from
// the user's whole portfolio + decision history — something no per-repo tool can
// do, because it spans projects and time. Reads triage_events (the verdicts +
// writeups we already store) + the graph, matched both semantically (embed the
// query) and by keyword.

import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client";
import { embed, parseStoredEmbedding, parseStoredFacetEmbeddings, cosineSimilarity } from "../lib/embeddings";
import { isCodeFacet } from "../projects/immersion";

const norm = (s: string) => s.toLowerCase();
const STOP = new Set(["the", "a", "an", "for", "to", "of", "in", "on", "we", "have", "has", "what", "did", "do", "does", "our", "my", "is", "are", "with", "and", "or", "about", "any", "use", "used", "using"]);
function tokens(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9.+#-]+/).filter((t) => t.length >= 3 && !STOP.has(t)))];
}
function keywordHits(text: string | null | undefined, toks: string[]): number {
  if (!text) return 0;
  const lc = text.toLowerCase();
  return toks.reduce((n, t) => n + (lc.includes(t) ? 1 : 0), 0);
}

// `paths` are the evidence anchors — where the capability is implemented,
// attributed per project ("acme: src/cv/transformations.py"). This is what
// lets an agent FOLLOW a portfolio convention instead of re-deriving it.
export type RecallCapability = { capability: string; projects: string[]; provenance: string; score: number; paths: string[] };
export type RecallDecision = {
  repo: string; project: string | null; verdict: string; reasonCode: string | null;
  score: number | null; effort: string | null; oneLine: string | null; at: string | null; relevance: number;
};
// A passage from a project's grounded agent report (the onboarding code-read
// write-up) that matches the query — answers ARCHITECTURE questions ("how does
// X handle auth?", "which repo does its own scraping?") that verdicts can't.
export type RecallReport = { project: string; snippet: string; relevance: number };
// User-anchored notes (set on Atlas nodes) — institutional memory tied to a
// capability/tool/project, not free-floating text.
export type RecallNote = { kind: string; nodeKey: string; note: string };
export type RecallResult = { query: string; capabilities: RecallCapability[]; decisions: RecallDecision[]; reports: RecallReport[]; notes: RecallNote[] };

export async function recall(userId: number, opts: { query: string; verdict?: string; limit?: number }): Promise<RecallResult> {
  const limit = opts.limit ?? 8;
  const toks = tokens(opts.query);
  // embed the query once for semantic recall (best-effort; keyword still works without it)
  let qvec: number[] | null = null;
  try { const r = await embed(opts.query); qvec = r?.vector ?? null; } catch { qvec = null; }

  const projects = await db.select().from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true), eq(schema.projectProfiles.included, true)));
  const slugById = new Map(projects.map((p) => [p.id, p.slug]));

  // ── capabilities: which the user has that match the query, and where ──
  const capAgg = new Map<string, { projects: Set<string>; best: number; provenance: string; paths: string[] }>();
  for (const p of projects) {
    for (const f of parseStoredFacetEmbeddings(p.facetEmbeddings ?? null)) {
      if (isCodeFacet(f)) continue; // code-content facets are matching-only; the
      // descriptor facet for the same capability already carries its paths.
      const kw = keywordHits(f.label, toks);
      const sem = qvec ? cosineSimilarity(qvec, f.vec) : 0;
      const score = kw * 0.5 + (Number.isFinite(sem) ? Math.max(0, sem) : 0);
      if (kw === 0 && sem < 0.45) continue; // not relevant
      const key = norm(f.label);
      const cur = capAgg.get(key) ?? { projects: new Set<string>(), best: 0, provenance: f.provenance ?? "inferred", paths: [] };
      cur.projects.add(p.slug);
      cur.best = Math.max(cur.best, score);
      // prefer the strongest provenance seen
      const order: Record<string, number> = { grounded: 3, extracted: 2, inferred: 1, ambiguous: 0 };
      if ((order[f.provenance ?? "inferred"] ?? 1) > (order[cur.provenance] ?? 1)) cur.provenance = f.provenance ?? "inferred";
      // evidence anchors, attributed per project, capped to stay scannable
      for (const path of f.paths ?? []) {
        const entry = `${p.slug}: ${path}`;
        if (cur.paths.length < 6 && !cur.paths.includes(entry)) cur.paths.push(entry);
      }
      capAgg.set(key, cur);
    }
  }
  const capabilities: RecallCapability[] = [...capAgg.entries()]
    .map(([label, v]) => ({ capability: label, projects: [...v.projects], provenance: v.provenance, score: v.best, paths: v.paths }))
    .sort((a, b) => b.score - a.score).slice(0, limit);

  // ── reports: passages from the grounded agent write-ups that match ──
  // The onboarding agent's code-read report is the richest text we hold about
  // each project; keyword-match it and return the best paragraph so recall can
  // answer architecture questions, not just "what did we decide".
  const reports: RecallReport[] = [];
  if (toks.length > 0) {
    for (const p of projects) {
      if (!p.agentReport) continue;
      let bestPara: string | null = null;
      let bestHits = 0;
      for (const para of p.agentReport.split(/\n{2,}/)) {
        const trimmed = para.trim();
        if (trimmed.length < 40) continue; // headings / list stubs
        const hits = keywordHits(trimmed, toks);
        if (hits > bestHits) { bestHits = hits; bestPara = trimmed; }
      }
      if (bestPara && bestHits > 0) {
        reports.push({
          project: p.slug,
          snippet: bestPara.length > 500 ? `${bestPara.slice(0, 500)}…` : bestPara,
          relevance: bestHits,
        });
      }
    }
    reports.sort((a, b) => b.relevance - a.relevance);
    reports.length = Math.min(reports.length, 3); // keep top 3 (clearer than splice)
  }

  // ── decisions: evaluated candidates matching the query, latest per (project, repo) ──
  const events = await db.select({
    repoId: schema.triageEvents.repoId, projectId: schema.triageEvents.projectId, verdict: schema.triageEvents.verdict,
    score: schema.triageEvents.score, effortBand: schema.triageEvents.effortBand, oneLine: schema.triageEvents.oneLine,
    writeup: schema.triageEvents.writeup, reasonCode: schema.triageEvents.reasonCode, matchedFacet: schema.triageEvents.matchedFacet,
    createdAt: schema.triageEvents.createdAt, id: schema.triageEvents.id,
  }).from(schema.triageEvents).where(eq(schema.triageEvents.userId, userId));
  const latest = new Map<string, typeof events[number]>();
  const repoIds = new Set<number>();
  for (const e of events) {
    repoIds.add(e.repoId);
    const k = `${e.projectId ?? "g"}:${e.repoId}`;
    const prev = latest.get(k);
    if (!prev || (e.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) latest.set(k, e);
  }
  const repoRows = repoIds.size ? await db.select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name }).from(schema.repos) : [];
  const repoById = new Map(repoRows.filter((r) => repoIds.has(r.id)).map((r) => [r.id, r]));

  const decisions: RecallDecision[] = [];
  for (const e of latest.values()) {
    if (opts.verdict && e.verdict !== opts.verdict) continue;
    const repo = repoById.get(e.repoId); if (!repo) continue;
    const fullName = `${repo.owner}/${repo.name}`;
    let rel = keywordHits(fullName, toks) + keywordHits(e.matchedFacet, toks) + keywordHits(e.oneLine, toks) * 0.5 + keywordHits(e.writeup, toks) * 0.25;
    if (qvec) {
      const cat = await db.select({ embedding: schema.catalogueRepos.embedding }).from(schema.catalogueRepos).where(eq(schema.catalogueRepos.fullName, fullName)).get();
      const emb = parseStoredEmbedding(cat?.embedding ?? null);
      if (emb) { const c = cosineSimilarity(qvec, emb); if (Number.isFinite(c)) rel += Math.max(0, c); }
    }
    // a bare verdict filter (e.g. "what have we ported") with no topical terms still returns all matching verdicts
    if (rel === 0 && !(opts.verdict && toks.length === 0)) continue;
    decisions.push({
      repo: fullName, project: e.projectId != null ? slugById.get(e.projectId) ?? null : null,
      verdict: e.verdict, reasonCode: e.reasonCode, score: e.score, effort: e.effortBand, oneLine: e.oneLine,
      at: e.createdAt?.toISOString() ?? null, relevance: rel,
    });
  }
  decisions.sort((a, b) => b.relevance - a.relevance);
  decisions.length = Math.min(decisions.length, limit); // keep top `limit`

  // ── anchored notes: user-written, node-tied, keyword-matched ──
  const noteRows = await db.select().from(schema.nodeNotes).where(eq(schema.nodeNotes.userId, userId));
  const notes: RecallNote[] = noteRows
    .map((n) => ({ n, rel: keywordHits(n.note, toks) + keywordHits(n.nodeKey, toks) * 2 }))
    .filter((x) => x.rel > 0)
    .sort((a, b) => b.rel - a.rel)
    .slice(0, 4)
    .map((x) => ({ kind: x.n.kind, nodeKey: x.n.nodeKey, note: x.n.note }));

  return { query: opts.query, capabilities, decisions, reports, notes };
}
