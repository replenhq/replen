import { lt } from "drizzle-orm";
import { db, schema } from "@/db/client";

export type EventKind =
  | "fetch_start"
  | "fetch_done"
  | "scan"
  | "skip"
  | "triage_skip"
  | "reason"
  | "score"
  | "match"
  | "error";

// Fire-and-forget event write. Pipeline progress is best-effort: if the
// insert fails we still want the analysis itself to continue, so we swallow
// errors and just log a warning. Returns a promise the caller can await if
// they care about ordering (the live UI does not — it just polls).
// pipeline_events is append-only progress telemetry (several rows per user per
// run, daily). Prune rows older than `days` so the table can't grow unbounded.
// Called from the nightly aging cron. Returns rows deleted.
export async function prunePipelineEvents(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await db.delete(schema.pipelineEvents).where(lt(schema.pipelineEvents.createdAt, cutoff));
  return (res as { rowsAffected?: number }).rowsAffected ?? 0;
}

// Candidate rows accumulate every run and are never otherwise deleted (the
// inventory only ever READS them within a lookback window). Prune fetched rows
// far older than any lookback so the table can't grow without bound. The window
// is deliberately generous (default 365d, well past the inventory lookback and
// any recent triage attribution) and can be disabled by setting the days to 0.
// Runs in the nightly cron alongside prunePipelineEvents.
export async function pruneOldCandidates(days = Number(process.env.REPLEN_CANDIDATE_RETENTION_DAYS ?? 365)): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0; // retention disabled
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await db.delete(schema.candidates).where(lt(schema.candidates.fetchedAt, cutoff));
  return (res as { rowsAffected?: number }).rowsAffected ?? 0;
}

export function recordEvent(
  runId: number,
  userId: number,
  kind: EventKind,
  message: string
): Promise<void> {
  return db
    .insert(schema.pipelineEvents)
    .values({ runId, userId, kind, message })
    .then(() => undefined, (e) => {
      console.warn(`[events] write failed (${kind}: ${message})`, e);
    });
}
