import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { startPipelineForUser } from "@/scheduler/run-once";
import { authenticate, corsHeaders } from "../_auth";

const MIN_RUN_GAP_MS = 60_000;
// A run that's been "in flight" this long never finalised — the process died
// mid-run (crash, OOM, or a deploy restart). Without this, that zombie record
// (finishedAt = NULL) blocks every future run, including the daily cron,
// forever. Real runs finish in a couple of minutes; 10 is a safe backstop.
const STALE_RUN_MS = 10 * 60_000;

// Trigger a pipeline run for the authenticated user. Same rate-limit + in-
// flight guards as the server action behind the dashboard refresh button, so
// agents calling this from a terminal cannot stack runs on top of each other.
// Returns the run id immediately; clients should poll /api/mcp/status to see
// progress.
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const inFlight = await db
    .select({ id: schema.digestRuns.id, startedAt: schema.digestRuns.startedAt })
    .from(schema.digestRuns)
    .where(and(eq(schema.digestRuns.userId, auth.userId), isNull(schema.digestRuns.finishedAt)))
    .get();
  if (inFlight) {
    const startedMs = inFlight.startedAt?.getTime() ?? 0;
    if (startedMs && Date.now() - startedMs < STALE_RUN_MS) {
      return NextResponse.json(
        { ok: false, status: "in_flight", runId: inFlight.id, startedAt: inFlight.startedAt, reason: "a run is already in flight" },
        { status: 409, headers: corsHeaders },
      );
    }
    // Stale: the previous run never finalised (process died mid-run). Finalise
    // it so it stops blocking, then fall through to start a fresh run.
    await db
      .update(schema.digestRuns)
      .set({ finishedAt: new Date() })
      .where(eq(schema.digestRuns.id, inFlight.id));
    console.warn(`[run-now] finalised stale in-flight run ${inFlight.id} (started ${inFlight.startedAt?.toISOString() ?? "?"})`);
  }

  const cutoff = new Date(Date.now() - MIN_RUN_GAP_MS);
  const recent = await db
    .select({ id: schema.digestRuns.id, startedAt: schema.digestRuns.startedAt })
    .from(schema.digestRuns)
    .where(and(eq(schema.digestRuns.userId, auth.userId), gte(schema.digestRuns.startedAt, cutoff)))
    .orderBy(desc(schema.digestRuns.id))
    .get();
  if (recent) {
    return NextResponse.json(
      { ok: false, status: "rate_limited", runId: recent.id, startedAt: recent.startedAt, reason: `previous run started < ${MIN_RUN_GAP_MS / 1000}s ago` },
      { status: 429, headers: corsHeaders },
    );
  }

  const result = await startPipelineForUser(auth.userId);
  if ("skipped" in result) {
    return NextResponse.json({ ok: false, status: "skipped", reason: result.skipped }, { status: 409, headers: corsHeaders });
  }
  return NextResponse.json({ ok: true, status: "started", runId: result.runId }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
