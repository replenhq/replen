// Floor calibration — the relevance floor learns from outcomes.
//
// Every triage event now carries the cosine its candidate surfaced at
// (matched_cosine), so each project accumulates labeled (cosine → verdict)
// pairs. Once a project has enough adopted/ported examples, its floor moves
// to just under where its adoptions actually happen — a project whose wins
// all land at 0.6+ stops being interrupted by 0.49s, and one that genuinely
// adopts at 0.5 keeps its wide gate. Bounded above the global default so the
// floor only ever tightens, never loosens below the configured minimum.

import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/client";

const MIN_EXAMPLES = Math.max(3, parseInt(process.env.REPLEN_CALIBRATION_MIN_N ?? "5", 10) || 5);
const MARGIN = Math.max(0, parseFloat(process.env.REPLEN_CALIBRATION_MARGIN ?? "0.03"));
const MAX_TIGHTEN = Math.max(0, parseFloat(process.env.REPLEN_CALIBRATION_MAX_TIGHTEN ?? "0.12"));

export async function calibratedFloor(userId: number, projectId: number | null, fallback: number): Promise<number> {
  const events = await db.select({
    projectId: schema.triageEvents.projectId,
    verdict: schema.triageEvents.verdict,
    cosine: schema.triageEvents.matchedCosine,
  }).from(schema.triageEvents)
    .where(and(eq(schema.triageEvents.userId, userId), isNotNull(schema.triageEvents.matchedCosine)));
  if (!events.length) return fallback;

  // Project-scoped sample first; fall back to the user's whole history when
  // the project alone is too thin (taste transfers reasonably within a user).
  const pick = (rows: typeof events) => rows
    .filter((e) => (e.verdict === "adopt" || e.verdict === "port") && typeof e.cosine === "number")
    .map((e) => e.cosine as number);
  let adopted = projectId != null ? pick(events.filter((e) => e.projectId === projectId)) : [];
  if (adopted.length < MIN_EXAMPLES) adopted = pick(events);
  if (adopted.length < MIN_EXAMPLES) return fallback;

  adopted.sort((a, b) => a - b);
  const p25 = adopted[Math.floor(adopted.length * 0.25)];
  const floor = p25 - MARGIN;
  return Math.min(Math.max(floor, fallback), fallback + MAX_TIGHTEN);
}
