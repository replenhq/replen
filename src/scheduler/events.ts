import { db, schema } from "@/db/client";

export type EventKind =
  | "fetch_start"
  | "fetch_done"
  | "scan"
  | "skip"
  | "triage_skip"
  | "reason"
  | "match"
  | "error";

// Fire-and-forget event write. Pipeline progress is best-effort: if the
// insert fails we still want the analysis itself to continue, so we swallow
// errors and just log a warning. Returns a promise the caller can await if
// they care about ordering (the live UI does not — it just polls).
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
