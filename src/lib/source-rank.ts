// Source priority for picking which candidate to show on the dashboard when
// the same repo surfaces via multiple posts. Lower index = higher priority.
//
// Rationale: TikTok and Threads come with embedded video/post that adds
// context above the writeup. Reddit/HN are text-only. gh-trending has no
// associated post at all, so it's last.

import { db, schema } from "@/db/client";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export const SOURCE_RANK: string[] = ["tiktok", "threads", "reddit", "hn", "gh-trending", "ossinsight-trending"];

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
    // Smoothed ratio centred around 1.0, capped so weak evidence never deletes
    // a source from contention. Prior of 2 (not 1) so a SINGLE 'good' lands at
    // 3/2=1.5 rather than immediately pinning the 2.0 cap — the ratio should
    // approach the cap gradually as evidence accumulates.
    const PRIOR = 2;
    const raw = (g + PRIOR) / (b + PRIOR);
    weights.set(r.kind, Math.max(0.25, Math.min(2.0, raw)));
  }
  return weights;
}

// Parse the trending-windows membership info stashed in a gh-trending or
// ossinsight-trending candidate's rawJson. Returns the windows present
// (e.g. ["daily","weekly"] for gh-trending, ["past_3_months","past_month"]
// for ossinsight-trending) and a multiplier to apply to the candidate's
// score so sustained-trending repos out-rank single-window spikes. Returns
// null when the source isn't a trending fetcher or the rawJson doesn't
// carry the field.
//
// Multiplier rationale:
//   gh-trending: all three windows = consistent star activity across
//     timescales (strongest "real, not hype" signal). Weekly+monthly
//     without daily = "trending but cooled off today" (still beats a
//     one-day spike). Daily-only = could be a viral push that won't stick.
//   ossinsight-trending: past_3_months is the long-haul signal — sustained
//     attention over a quarter, much stronger than gh-trending's monthly
//     window. Both periods together = "sustained AND still rising now".
export function parseTrendingMembership(
  source: string,
  rawJson: string | null | undefined,
): { windows: string[]; multiplier: number } | null {
  const kind = sourceKind(source);
  if (kind !== "gh-trending" && kind !== "ossinsight-trending") return null;
  if (!rawJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (kind === "gh-trending") {
    const w = (parsed as { windows?: unknown }).windows;
    if (!Array.isArray(w)) return null;
    const windows = w.filter((x): x is string => typeof x === "string");
    const hasD = windows.includes("daily");
    const hasW = windows.includes("weekly");
    const hasM = windows.includes("monthly");
    let multiplier = 1.0;
    if (hasD && hasW && hasM) multiplier = 1.5;
    else if (hasW && hasM) multiplier = 1.3;
    else if (hasW || hasM) multiplier = 1.1;
    return { windows, multiplier };
  }
  // ossinsight-trending — same idea but on the periods axis.
  const p = (parsed as { periods?: unknown }).periods;
  if (!Array.isArray(p)) return null;
  const periods = p.filter((x): x is string => typeof x === "string");
  const has3m = periods.includes("past_3_months");
  const hasM = periods.includes("past_month");
  let multiplier = 1.0;
  // Both = highest signal: surviving 3-month decay AND still on the monthly
  // chart. past_3_months alone is still strong long-haul. past_month alone
  // mostly duplicates gh-trending's monthly so we don't boost it further.
  if (has3m && hasM) multiplier = 1.4;
  else if (has3m) multiplier = 1.25;
  return { windows: periods, multiplier };
}
