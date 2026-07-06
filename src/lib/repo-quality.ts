// Cross-user repo quality aggregate (the L4 learning loop).
//
// `repo_quality` is a materialised view over `triage_events`: one row per
// repo, summarising how the repo fared across ALL users. Each user is counted
// ONCE, by their LATEST verdict on the repo, so a single user re-evaluating
// the same repo three times doesn't triple-count. We recompute a repo's whole
// row from its events on every triage write (cheap — triage volume per repo is
// low) rather than maintaining counters incrementally, which keeps the
// aggregate impossible to drift out of sync with the source of truth.

import { db, schema } from "@/db/client";
import { eq, and, ne } from "drizzle-orm";

export type RepoQualityTallies = {
  adoptUsers: number;
  portUsers: number;
  skipUsers: number;
  deferUsers: number;
  totalUsers: number;
  avgScore: number | null;
  lastTriagedAt: Date | null;
};

// Reduce a repo's full triage history to per-user-latest verdict tallies.
// Exported so the inventory route and the backfill CLI share one definition
// of "how a repo's quality is computed".
export function tallyLatestVerdicts(
  events: Array<{ userId: number; verdict: string; score: number | null; createdAt: Date | null; id: number }>,
): RepoQualityTallies {
  // Each user's most recent verdict wins (createdAt, then id as a tiebreak for
  // events written within the same millisecond).
  const latest = new Map<number, { verdict: string; score: number | null; at: number; id: number }>();
  for (const e of events) {
    const at = e.createdAt ? e.createdAt.getTime() : 0;
    const prev = latest.get(e.userId);
    if (!prev || at > prev.at || (at === prev.at && e.id > prev.id)) {
      latest.set(e.userId, { verdict: e.verdict, score: e.score, at, id: e.id });
    }
  }

  let adoptUsers = 0, portUsers = 0, skipUsers = 0, deferUsers = 0;
  let scoreSum = 0, scoreCount = 0, lastAt = 0;
  for (const v of latest.values()) {
    // All 7 accepted verdicts must fall into a bucket or totalUsers (=latest.size)
    // no longer equals adopt+port+skip+defer, and genuinely-useful repos (ones
    // users cherry-picked / clean-roomed / upgraded to) would show as un-adopted.
    // upgrade = switched TO this repo (adopt-like); cherry-pick / clean-room =
    // took or reimplemented its code (port-like).
    if (v.verdict === "adopt" || v.verdict === "upgrade") adoptUsers++;
    else if (v.verdict === "port" || v.verdict === "cherry-pick" || v.verdict === "clean-room") portUsers++;
    else if (v.verdict === "skip") skipUsers++;
    else if (v.verdict === "defer") deferUsers++;
    if (typeof v.score === "number") { scoreSum += v.score; scoreCount++; }
    if (v.at > lastAt) lastAt = v.at;
  }
  return {
    adoptUsers,
    portUsers,
    skipUsers,
    deferUsers,
    totalUsers: latest.size,
    avgScore: scoreCount > 0 ? scoreSum / scoreCount : null,
    lastTriagedAt: lastAt > 0 ? new Date(lastAt) : null,
  };
}

// Recompute and persist the quality row for one repo from its triage_events.
// Idempotent: deletes the row when no triages remain. Call after every triage
// write (best-effort — a failure here must never fail the triage itself).
export async function recomputeRepoQuality(repoId: number, now: Date = new Date()): Promise<void> {
  const events = await db
    .select({
      userId: schema.triageEvents.userId,
      verdict: schema.triageEvents.verdict,
      score: schema.triageEvents.score,
      createdAt: schema.triageEvents.createdAt,
      id: schema.triageEvents.id,
    })
    .from(schema.triageEvents)
    .innerJoin(schema.users, eq(schema.users.id, schema.triageEvents.userId))
    // Test-cohort triages never enter the cross-user repo_quality aggregate,
    // so they can't drive global-demote or cross-user leaps for real users.
    .where(and(eq(schema.triageEvents.repoId, repoId), ne(schema.users.role, "test")));

  const t = tallyLatestVerdicts(events);

  if (t.totalUsers === 0) {
    await db.delete(schema.repoQuality).where(eq(schema.repoQuality.repoId, repoId));
    return;
  }

  const row = {
    repoId,
    adoptUsers: t.adoptUsers,
    portUsers: t.portUsers,
    skipUsers: t.skipUsers,
    deferUsers: t.deferUsers,
    totalUsers: t.totalUsers,
    avgScore: t.avgScore,
    lastTriagedAt: t.lastTriagedAt,
    updatedAt: now,
  };

  await db
    .insert(schema.repoQuality)
    .values(row)
    .onConflictDoUpdate({
      target: schema.repoQuality.repoId,
      set: {
        adoptUsers: row.adoptUsers,
        portUsers: row.portUsers,
        skipUsers: row.skipUsers,
        deferUsers: row.deferUsers,
        totalUsers: row.totalUsers,
        avgScore: row.avgScore,
        lastTriagedAt: row.lastTriagedAt,
        updatedAt: row.updatedAt,
      },
    });
}

// Decision helpers — one definition of the thresholds, shared by the route.
// A repo is GLOBALLY DEMOTED when enough distinct users have triaged it and a
// dominant share of them last called it 'skip' (rubbish). Env-tunable.
export function globalDemoteThresholds() {
  return {
    minUsers: Math.max(1, parseInt(process.env.REPLEN_GLOBAL_SKIP_MIN ?? "3", 10) || 3),
    skipRatio: Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_GLOBAL_SKIP_RATIO ?? "0.6"))),
  };
}

export function isGloballyDemoted(q: { skipUsers: number; totalUsers: number }): boolean {
  const { minUsers, skipRatio } = globalDemoteThresholds();
  return q.totalUsers >= minUsers && q.skipUsers / q.totalUsers >= skipRatio;
}
