import { db, schema } from "@/db/client";
import { desc, gte, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

// Pipeline / cron health. Answers "is the pipeline actually running, and is
// anything silently failing?" — read straight off digest_runs (timings +
// error_log + paused_reason already stored per run).

function fmtDur(startedAt: Date, finishedAt: Date | null): string {
  if (!finishedAt) return "…running";
  const ms = finishedAt.getTime() - startedAt.getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m ${s % 60}s`;
}

type RunState = { label: string; color: string };
function runState(r: { finishedAt: Date | null; errorLog: string | null; pausedReason: string | null }): RunState {
  if (!r.finishedAt) return { label: "running", color: "#92400e" };
  if (r.errorLog) return { label: "error", color: "#b91c1c" };
  if (r.pausedReason) return { label: `paused · ${r.pausedReason}`, color: "#92400e" };
  return { label: "ok", color: "#166534" };
}

export default async function PipelineAdmin() {
  await requireAdmin();

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const runs = await db.select().from(schema.digestRuns).orderBy(desc(schema.digestRuns.startedAt)).limit(40);

  const runs24 = await db.select({ c: sql<number>`count(*)` }).from(schema.digestRuns).where(gte(schema.digestRuns.startedAt, dayAgo)).get();
  const err24 = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.digestRuns)
    .where(sql`${schema.digestRuns.startedAt} >= ${dayAgo} AND ${schema.digestRuns.errorLog} IS NOT NULL AND ${schema.digestRuns.errorLog} != ''`)
    .get();

  const userIds = [...new Set(runs.map((r) => r.userId).filter((x): x is number => x != null))];
  const emailById = new Map<number, string>();
  for (const id of userIds) {
    const u = await db.select({ email: schema.users.email }).from(schema.users).where(sql`${schema.users.id} = ${id}`).get();
    if (u) emailById.set(id, u.email);
  }

  const lastRun = runs[0];
  const lastState = lastRun ? runState(lastRun) : null;
  const errCount = Number(err24?.c ?? 0);

  return (
    <>
      <h1>Pipeline health</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, maxWidth: 640, marginTop: 12 }}>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border,#ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Runs (24h)</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{Number(runs24?.c ?? 0)}</div>
        </div>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border,#ddd)", borderRadius: 6, background: errCount > 0 ? "rgba(239,68,68,0.08)" : "transparent" }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Errored (24h)</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: errCount > 0 ? "#b91c1c" : undefined }}>{errCount}</div>
        </div>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border,#ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Last run</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>
            {lastRun ? <span style={{ color: lastState!.color }}>{lastState!.label}</span> : "—"}
          </div>
          <div className="meta" style={{ fontSize: 11, marginTop: 2 }}>{lastRun ? lastRun.startedAt.toISOString().slice(0, 16).replace("T", " ") : ""}</div>
        </div>
      </div>

      <h2 style={{ marginTop: 28 }}>Recent runs</h2>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>User</th>
              <th>Dur</th>
              <th>Repos</th>
              <th>Cands</th>
              <th>Matches</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const st = runState(r);
              return (
                <tr key={r.id}>
                  <td className="meta">{r.startedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="meta">{r.userId != null ? emailById.get(r.userId) ?? `#${r.userId}` : "—"}</td>
                  <td className="meta">{fmtDur(r.startedAt, r.finishedAt)}</td>
                  <td>{r.reposAnalyzed ?? 0}</td>
                  <td>{r.candidatesFound ?? 0}</td>
                  <td>{r.matchesCreated ?? 0}</td>
                  <td style={{ color: st.color, fontWeight: 500 }} title={r.errorLog ?? undefined}>{st.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {runs.some((r) => r.errorLog) && (
        <>
          <h2 style={{ marginTop: 28 }}>Latest error logs</h2>
          {runs.filter((r) => r.errorLog).slice(0, 5).map((r) => (
            <details key={r.id} style={{ margin: "8px 0" }}>
              <summary className="meta">
                {r.startedAt.toISOString().slice(0, 16).replace("T", " ")} · {r.userId != null ? emailById.get(r.userId) ?? `#${r.userId}` : "—"}
              </summary>
              <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", background: "var(--surface-1,#f6f6f6)", padding: 10, borderRadius: 4, overflowX: "auto" }}>{r.errorLog}</pre>
            </details>
          ))}
        </>
      )}
    </>
  );
}
