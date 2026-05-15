// Source priority for picking which candidate to show on the dashboard when
// the same repo surfaces via multiple posts. Lower index = higher priority.
//
// Rationale: TikTok and Threads come with embedded video/post that adds
// context above the writeup. Reddit/HN are text-only. gh-trending has no
// associated post at all, so it's last.

import { db, schema } from "@/db/client";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export const SOURCE_RANK: string[] = ["tiktok", "threads", "reddit", "hn", "gh-trending"];

export function sourceKind(source: string): string {
  const colon = source.indexOf(":");
  return colon === -1 ? source : source.slice(0, colon);
}

export function sourceRank(source: string): number {
  const idx = SOURCE_RANK.indexOf(sourceKind(source));
  return idx === -1 ? SOURCE_RANK.length : idx; // unknown → least preferred
}

// Per-source quality multiplier derived from a user's good/bad feedback.
// Returns a map { sourceKind → multiplier in [0.25, 2.0] }. Used to weight
// candidate scores during analysis: chronically-bad sources sink, validated
// ones get boosted. Laplace smoothing (start at neutral) prevents a single
// 👎 from instantly tanking a source.
export async function getSourceQualityWeights(userId: number): Promise<Map<string, number>> {
  const rows = await db
    .select({
      kind: schema.matches.sourceKind,
      good: sql<number>`sum(case when ${schema.matches.userFeedback} = 'good' then 1 else 0 end)`,
      bad: sql<number>`sum(case when ${schema.matches.userFeedback} = 'bad' then 1 else 0 end)`,
    })
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, userId), isNotNull(schema.matches.sourceKind)))
    .groupBy(schema.matches.sourceKind);

  const weights = new Map<string, number>();
  for (const r of rows) {
    if (!r.kind) continue;
    const g = Number(r.good ?? 0);
    const b = Number(r.bad ?? 0);
    // Smoothed ratio: (g+1) / (b+1) centred around 1.0. Capped so we never
    // delete a source from contention entirely on weak evidence.
    const raw = (g + 1) / (b + 1);
    weights.set(r.kind, Math.max(0.25, Math.min(2.0, raw)));
  }
  return weights;
}
