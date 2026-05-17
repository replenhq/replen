import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, asc, desc, eq, gt, gte, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

const EVENT_TAIL = 60;

// Mirrors /api/pipeline-status for MCP clients (terminal agents). Returns the
// current/most-recent run for the caller with live counts pulled from
// candidates + matches (digest_runs counters only land at the end of a run)
// plus the tail of pipeline_events so an agent can show a "what's the
// pipeline doing right now" view. Supports ?since=<event_id> for incremental
// polling, matching the in-app live log.
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? parseInt(sinceParam, 10) : 0;
  const sinceId = Number.isFinite(since) && since > 0 ? since : 0;

  const run = await db
    .select()
    .from(schema.digestRuns)
    .where(eq(schema.digestRuns.userId, auth.userId))
    .orderBy(desc(schema.digestRuns.id))
    .get();

  if (!run) {
    return NextResponse.json({ inFlight: false, events: [] }, { headers: corsHeaders });
  }

  const inFlight = run.finishedAt == null;

  let candidates = Number(run.candidatesFound ?? 0);
  let matches = Number(run.matchesCreated ?? 0);
  if (inFlight) {
    const candRow = await db
      .select({ c: sql<number>`count(*)` })
      .from(schema.candidates)
      .where(and(eq(schema.candidates.userId, auth.userId), gte(schema.candidates.fetchedAt, run.startedAt)))
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

  return NextResponse.json(
    {
      inFlight,
      runId: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      candidates,
      matches,
      phase,
      events,
    },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
