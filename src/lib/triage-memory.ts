// Triage memory — reading the decision log BACK into matching.
//
// triage_events has always been written by the in-session agent (verdict,
// matchedFacet, facetModality, reasonCode) but, until this module, only the
// blunt signals were read back (per-user skip suppression, global demote).
// These helpers close the loop on the contextual signals:
//
//   loadModalitySuppressions — (repo × modality) pairs the agents flagged as
//     modality collisions ("anomalib is an IMAGE anomaly lib; this facet is
//     timeseries"). Suppress the repo for facets of that modality only — the
//     repo stays perfectly matchable for users/projects where the modality
//     fits. Per-user signal always applies to that user; cross-user it needs
//     agreement from REPLEN_MODALITY_SUPPRESS_MIN distinct users. Privacy:
//     the aggregate is (public repo × modality enum) — no user vocabulary.
//
//   loadTriageContext — the per-user prior-decision index the inventory
//     endpoint attaches to candidates as `priorContext` ("you already cover
//     'OCR' with tesseract, adopted Mar 2026"), so the in-session agent
//     triages with memory instead of from scratch.
//
//   loadDeferRechecks — 'defer' means "not now", which is a promise to come
//     back. Latest-verdict defers older than the re-check window, on repos
//     that are still actively developed, get re-surfaced once in a while as
//     discovery mode 're-checked'.
//
// All of it is mechanical SQL + reduction — no LLM, per the cost model.

import { db, schema } from "@/db/client";
import { eq, inArray } from "drizzle-orm";
import { coerceModalities, type Modality } from "@/projects/modality";

// Same normalisation the inventory route uses for facet labels.
export const normFacetLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// facet_modality is stored as the agent sent it (≤120 chars): a JSON array
// ('["image"]'), a JSON string ('"image"'), or a bare/comma list ("image,video").
function parseModalities(raw: string | null): Modality[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const m = coerceModalities(arr);
    if (m.length) return m;
  } catch {
    // not JSON — fall through to the bare/comma form
  }
  return coerceModalities(raw.split(/[,\s]+/));
}

type TriageEventLite = {
  id: number;
  userId: number;
  repoId: number;
  projectId: number | null;
  verdict: string;
  reasonCode: string | null;
  facetModality: string | null;
  matchedFacet: string | null;
  oneLine: string | null;
  createdAt: Date | null;
};

// Reduce events to the latest per key (createdAt, then id as tiebreak) —
// the same "latest verdict wins" semantics as repo_quality.
function latestPerKey(events: TriageEventLite[], keyOf: (e: TriageEventLite) => string): Map<string, TriageEventLite> {
  const latest = new Map<string, TriageEventLite>();
  for (const e of events) {
    const k = keyOf(e);
    const at = e.createdAt?.getTime() ?? 0;
    const prev = latest.get(k);
    const prevAt = prev?.createdAt?.getTime() ?? 0;
    if (!prev || at > prevAt || (at === prevAt && e.id > prev.id)) latest.set(k, e);
  }
  return latest;
}

const eventCols = {
  id: schema.triageEvents.id,
  userId: schema.triageEvents.userId,
  repoId: schema.triageEvents.repoId,
  projectId: schema.triageEvents.projectId,
  verdict: schema.triageEvents.verdict,
  reasonCode: schema.triageEvents.reasonCode,
  facetModality: schema.triageEvents.facetModality,
  matchedFacet: schema.triageEvents.matchedFacet,
  oneLine: schema.triageEvents.oneLine,
  createdAt: schema.triageEvents.createdAt,
};

async function repoFullNames(repoIds: Iterable<number>): Promise<Map<number, string>> {
  const ids = [...new Set(repoIds)];
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name })
    .from(schema.repos)
    .where(inArray(schema.repos.id, ids));
  return new Map(rows.map((r) => [r.id, `${r.owner}/${r.name}`]));
}

// ── (repo × modality) suppression ────────────────────────────────────────────

// Map of repo fullName (lowercased) → modalities it must not match via.
// `forUserId`'s own collision verdicts always qualify; other users' need
// REPLEN_MODALITY_SUPPRESS_MIN distinct users to agree (one agent's mislabel
// must not suppress a repo for everyone).
export async function loadModalitySuppressions(forUserId: number): Promise<Map<string, Set<Modality>>> {
  const MIN_USERS = Math.max(1, parseInt(process.env.REPLEN_MODALITY_SUPPRESS_MIN ?? "2", 10) || 2);

  const events: TriageEventLite[] = await db.select(eventCols).from(schema.triageEvents);
  if (!events.length) return new Map();

  // Latest verdict per (user, repo): a later adopt/port lifts the collision.
  const latest = latestPerKey(events, (e) => `${e.userId}:${e.repoId}`);

  // (repoId × modality) → distinct users who flagged the collision.
  const byRepoMod = new Map<number, Map<Modality, Set<number>>>();
  for (const e of latest.values()) {
    if (e.verdict !== "skip" || e.reasonCode !== "modality-collision") continue;
    const mods = parseModalities(e.facetModality);
    if (!mods.length) continue;
    const modMap = byRepoMod.get(e.repoId) ?? new Map<Modality, Set<number>>();
    for (const m of mods) {
      const users = modMap.get(m) ?? new Set<number>();
      users.add(e.userId);
      modMap.set(m, users);
    }
    byRepoMod.set(e.repoId, modMap);
  }

  const qualifying = new Map<number, Set<Modality>>();
  for (const [repoId, modMap] of byRepoMod) {
    for (const [m, users] of modMap) {
      if (!users.has(forUserId) && users.size < MIN_USERS) continue;
      const set = qualifying.get(repoId) ?? new Set<Modality>();
      set.add(m);
      qualifying.set(repoId, set);
    }
  }
  if (!qualifying.size) return new Map();

  const names = await repoFullNames(qualifying.keys());
  const out = new Map<string, Set<Modality>>();
  for (const [repoId, mods] of qualifying) {
    const fullName = names.get(repoId);
    if (fullName) out.set(fullName.toLowerCase(), mods);
  }
  return out;
}

// ── prior-decision context ───────────────────────────────────────────────────

export type PriorDecision = { project: string | null; verdict: string; at: Date | null; oneLine: string | null };
export type FacetCoverage = { repo: string; project: string | null; verdict: string; at: Date | null };
export type TriageContext = {
  // normFacetLabel(facet) → the adopt/port that already fills it (most recent wins)
  coverage: Map<string, FacetCoverage>;
  // repo fullName (lowercased) → this user's latest decision per project (recent first, ≤3)
  repoHistory: Map<string, PriorDecision[]>;
};

export async function loadTriageContext(userId: number): Promise<TriageContext> {
  const events: TriageEventLite[] = await db.select(eventCols).from(schema.triageEvents)
    .where(eq(schema.triageEvents.userId, userId));
  if (!events.length) return { coverage: new Map(), repoHistory: new Map() };

  const projects = await db
    .select({ id: schema.projectProfiles.id, slug: schema.projectProfiles.slug })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  const slugById = new Map(projects.map((p) => [p.id, p.slug]));

  // Latest per (project, repo) so a repo skipped for one project but adopted
  // for another keeps both entries.
  const latest = latestPerKey(events, (e) => `${e.projectId ?? "g"}:${e.repoId}`);
  const names = await repoFullNames([...latest.values()].map((e) => e.repoId));

  const coverage = new Map<string, FacetCoverage>();
  const repoHistory = new Map<string, PriorDecision[]>();
  for (const e of latest.values()) {
    const fullName = names.get(e.repoId);
    if (!fullName) continue;
    const project = e.projectId != null ? slugById.get(e.projectId) ?? null : null;

    const hist = repoHistory.get(fullName.toLowerCase()) ?? [];
    hist.push({ project, verdict: e.verdict, at: e.createdAt, oneLine: e.oneLine });
    repoHistory.set(fullName.toLowerCase(), hist);

    if ((e.verdict === "adopt" || e.verdict === "port") && e.matchedFacet) {
      const key = normFacetLabel(e.matchedFacet);
      const prev = coverage.get(key);
      if (!prev || (e.createdAt?.getTime() ?? 0) > (prev.at?.getTime() ?? 0)) {
        coverage.set(key, { repo: fullName, project, verdict: e.verdict, at: e.createdAt });
      }
    }
  }
  for (const hist of repoHistory.values()) {
    hist.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    hist.splice(3);
  }
  return { coverage, repoHistory };
}

// ── defer re-checks ──────────────────────────────────────────────────────────

export type DeferRecheck = {
  repoId: number;
  fullName: string;
  url: string | null;
  description: string | null;
  stars: number | null;
  language: string | null;
  license: string | null;
  pushedAt: Date | null;
  deferredAt: Date;
  oneLine: string | null;
  projectSlug: string | null;
};

// Repos whose LATEST verdict for this user is 'defer', aged into the re-check
// window, on repos that still look alive. Oldest defer first (it has waited
// longest). `activeWithinDays` gates on repos.pushedAt; unknown pushedAt
// passes (unknown means "don't gate", same as the modality gate).
export async function loadDeferRechecks(
  userId: number,
  opts: { minAgeDays: number; maxAgeDays: number; activeWithinDays: number },
): Promise<DeferRecheck[]> {
  const events: TriageEventLite[] = await db.select(eventCols).from(schema.triageEvents)
    .where(eq(schema.triageEvents.userId, userId));
  if (!events.length) return [];

  const latest = latestPerKey(events, (e) => String(e.repoId));
  const now = Date.now();
  const minAge = opts.minAgeDays * 86400e3;
  const maxAge = opts.maxAgeDays * 86400e3;
  const deferred = [...latest.values()].filter((e) => {
    if (e.verdict !== "defer" || !e.createdAt) return false;
    const age = now - e.createdAt.getTime();
    return age >= minAge && age <= maxAge;
  });
  if (!deferred.length) return [];

  const repoRows = await db
    .select()
    .from(schema.repos)
    .where(inArray(schema.repos.id, deferred.map((e) => e.repoId)));
  const repoById = new Map(repoRows.map((r) => [r.id, r]));

  const projects = await db
    .select({ id: schema.projectProfiles.id, slug: schema.projectProfiles.slug })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  const slugById = new Map(projects.map((p) => [p.id, p.slug]));

  const activeSince = now - opts.activeWithinDays * 86400e3;
  const out: DeferRecheck[] = [];
  for (const e of deferred) {
    const r = repoById.get(e.repoId);
    if (!r) continue;
    if (r.pushedAt != null && r.pushedAt.getTime() < activeSince) continue; // gone quiet — still deferred
    out.push({
      repoId: r.id,
      fullName: `${r.owner}/${r.name}`,
      url: r.url,
      description: r.description,
      stars: r.stars,
      language: r.primaryLanguage,
      license: r.license,
      pushedAt: r.pushedAt,
      deferredAt: e.createdAt!,
      oneLine: e.oneLine,
      projectSlug: e.projectId != null ? slugById.get(e.projectId) ?? null : null,
    });
  }
  out.sort((a, b) => a.deferredAt.getTime() - b.deferredAt.getTime());
  return out;
}
