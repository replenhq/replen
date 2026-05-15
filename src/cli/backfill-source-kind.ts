// One-shot: backfill matches.source_kind from candidates for rows that
// predate the sourceKind insert in pipeline.ts (deployed 2026-05-15). For
// each match, find the highest-priority candidate covering the same repo
// (lowest sourceRank) belonging to the same user, and stamp that source
// kind onto the match.

import { db, schema } from "../db/client";
import { and, eq, isNull } from "drizzle-orm";
import { sourceKind, sourceRank } from "../lib/source-rank";

async function main() {
  const matches = await db
    .select({
      id: schema.matches.id,
      userId: schema.matches.userId,
      repoId: schema.matches.repoId,
      url: schema.repos.url,
    })
    .from(schema.matches)
    .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
    .where(isNull(schema.matches.sourceKind));

  console.log(`[backfill] ${matches.length} matches without source_kind`);
  let filled = 0;
  for (const m of matches) {
    if (!m.userId || !m.url) continue;
    const cs = await db
      .select({ source: schema.candidates.source })
      .from(schema.candidates)
      .where(and(eq(schema.candidates.userId, m.userId), eq(schema.candidates.githubUrl, m.url)));
    if (cs.length === 0) continue;
    let best: string | null = null;
    for (const c of cs) {
      const k = sourceKind(c.source);
      if (!best || sourceRank(k) < sourceRank(best)) best = k;
    }
    if (!best) continue;
    await db.update(schema.matches).set({ sourceKind: best }).where(eq(schema.matches.id, m.id));
    filled++;
  }
  console.log(`[backfill] filled ${filled} matches`);
}

main().catch((e) => { console.error(e); process.exit(1); });
