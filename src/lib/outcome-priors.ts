// Outcome priors — the lightweight bandit over (source, facet) arms.
//
// Every triage verdict is a pull: an adopt/port is a reward, a skip a miss.
// The Laplace-smoothed hit rate per SOURCE prefix ("gh-targeted", "catalogue",
// "stack-watch", …) and per MATCHED FACET becomes a small additive prior on
// ranking, centred on zero so an arm with no history changes nothing.
// Per-user by design: facet labels are the user's vocabulary and never
// aggregate across tenants.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";

const PRIOR_WEIGHT = Math.max(0, parseFloat(process.env.REPLEN_PRIOR_WEIGHT ?? "0.06"));

export type OutcomePriors = {
  facet: Map<string, { a: number; s: number }>;   // normalized facet label → tallies
  source: Map<string, { a: number; s: number }>;  // source prefix → tallies
};

const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
export const sourcePrefix = (s: string) => s.split(":")[0];

export async function loadOutcomePriors(userId: number): Promise<OutcomePriors> {
  const events = await db.select({
    id: schema.triageEvents.id, repoId: schema.triageEvents.repoId, projectId: schema.triageEvents.projectId,
    verdict: schema.triageEvents.verdict, matchedFacet: schema.triageEvents.matchedFacet,
    createdAt: schema.triageEvents.createdAt,
  }).from(schema.triageEvents).where(eq(schema.triageEvents.userId, userId));
  const facet = new Map<string, { a: number; s: number }>();
  const source = new Map<string, { a: number; s: number }>();
  if (!events.length) return { facet, source };

  // Latest verdict per (project, repo).
  const latest = new Map<string, typeof events[number]>();
  for (const e of events) {
    const k = `${e.projectId ?? "g"}:${e.repoId}`;
    const prev = latest.get(k);
    const at = e.createdAt?.getTime() ?? 0;
    if (!prev || at > (prev.createdAt?.getTime() ?? 0) || (at === (prev.createdAt?.getTime() ?? 0) && e.id > prev.id)) latest.set(k, e);
  }

  // Source attribution: the latest candidate row for each triaged repo.
  const candRows = await db.select({ githubUrl: schema.candidates.githubUrl, source: schema.candidates.source, id: schema.candidates.id })
    .from(schema.candidates).where(eq(schema.candidates.userId, userId));
  const repoRows = await db.select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name }).from(schema.repos);
  const fullNameById = new Map(repoRows.map((r) => [r.id, `${r.owner}/${r.name}`.toLowerCase()]));
  const sourceByFullName = new Map<string, string>();
  for (const c of candRows) {
    const m = c.githubUrl?.match(/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/i);
    if (m) sourceByFullName.set(`${m[1]}/${m[2]}`.toLowerCase(), c.source); // later rows overwrite → latest wins
  }

  for (const e of latest.values()) {
    const positive = e.verdict === "adopt" || e.verdict === "port";
    const negative = e.verdict === "skip";
    if (!positive && !negative) continue; // defer is "not now", not signal
    if (e.matchedFacet) {
      const k = normLabel(e.matchedFacet);
      const t = facet.get(k) ?? { a: 0, s: 0 };
      if (positive) t.a++; else t.s++;
      facet.set(k, t);
    }
    const fn = fullNameById.get(e.repoId);
    const src = fn ? sourceByFullName.get(fn) : undefined;
    if (src) {
      const k = sourcePrefix(src);
      const t = source.get(k) ?? { a: 0, s: 0 };
      if (positive) t.a++; else t.s++;
      source.set(k, t);
    }
  }
  return { facet, source };
}

// Centred Laplace prior in [−w, +w]: (a+1)/(a+s+2) maps no-history to 0.5 → 0.
export function priorBoost(map: Map<string, { a: number; s: number }>, key: string | null | undefined, weight = PRIOR_WEIGHT): number {
  if (!key) return 0;
  const t = map.get(key.toLowerCase().replace(/[^a-z0-9]+/g, "")) ?? map.get(key);
  if (!t) return 0;
  const rate = (t.a + 1) / (t.a + t.s + 2);
  return (rate - 0.5) * 2 * weight;
}
