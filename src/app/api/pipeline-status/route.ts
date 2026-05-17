import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, asc, desc, eq, gt, gte, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

const EVENT_TAIL = 60;

// Status of the user's current/most-recent pipeline run. Polled by the
// dashboard's <LivePipelineStatus> while a run is in flight to show a
// progress strip and auto-refresh as matches land.
//
// The pipeline only updates digest_runs counters at the end of the run, so
// for live progress we count from the underlying tables instead:
//   candidates: candidates.fetched_at >= run.started_at, user-scoped
//   matches:    matches.run_id = run.id (via the idx_match_run index)
//
// Phase is inferred from those counts (the pipeline doesn't persist phase):
//   candidates = 0          → "fetching"
//   candidates > 0, m = 0   → "scoring"
//   matches > 0             → "writing"
// Optional ?since=<event_id> query lets the client poll incrementally —
// the server only returns events newer than the last one already on screen.
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const sinceParam = url.searchParams.get("since");
    const since = sinceParam ? parseInt(sinceParam, 10) : 0;
    const sinceId = Number.isFinite(since) && since > 0 ? since : 0;

    const run = await db
      .select()
      .from(schema.digestRuns)
      .where(eq(schema.digestRuns.userId, user.id))
      .orderBy(desc(schema.digestRuns.id))
      .get();

    if (!run) return NextResponse.json({ inFlight: false, events: [] });

    const inFlight = run.finishedAt == null;

    let candidates = Number(run.candidatesFound ?? 0);
    let matches = Number(run.matchesCreated ?? 0);
    if (inFlight) {
      const candRow = await db
        .select({ c: sql<number>`count(*)` })
        .from(schema.candidates)
        .where(and(eq(schema.candidates.userId, user.id), gte(schema.candidates.fetchedAt, run.startedAt)))
        .get();
      candidates = Number(candRow?.c ?? 0);
      const matchRow = await db
        .select({ c: sql<number>`count(*)` })
        .from(schema.matches)
        .where(eq(schema.matches.runId, run.id))
        .get();
      matches = Number(matchRow?.c ?? 0);
    }

    let phase: "fetching" | "scoring" | "writing" | "done" = "done";
    if (inFlight) {
      if (candidates === 0) phase = "fetching";
      else if (matches === 0) phase = "scoring";
      else phase = "writing";
    }

    // Tail of the events log. Incremental: client passes ?since=<last_id> and
    // only gets new rows. On first load (since=0) we return the last
    // EVENT_TAIL rows oldest-first so the strip can show recent history.
    const events = sinceId > 0
      ? await db
          .select({
            id: schema.pipelineEvents.id,
            kind: schema.pipelineEvents.kind,
            message: schema.pipelineEvents.message,
            createdAt: schema.pipelineEvents.createdAt,
          })
          .from(schema.pipelineEvents)
          .where(and(eq(schema.pipelineEvents.runId, run.id), gt(schema.pipelineEvents.id, sinceId)))
          .orderBy(asc(schema.pipelineEvents.id))
      : (await db
          .select({
            id: schema.pipelineEvents.id,
            kind: schema.pipelineEvents.kind,
            message: schema.pipelineEvents.message,
            createdAt: schema.pipelineEvents.createdAt,
          })
          .from(schema.pipelineEvents)
          .where(eq(schema.pipelineEvents.runId, run.id))
          .orderBy(desc(schema.pipelineEvents.id))
          .limit(EVENT_TAIL)).reverse();

    return NextResponse.json({
      inFlight,
      runId: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      pausedReason: run.pausedReason,
      candidates,
      matches,
      phase,
      events,
    });
  } catch (e) {
    console.error("[/api/pipeline-status]", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
