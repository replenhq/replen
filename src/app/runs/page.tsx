import { db, schema } from "@/db/client";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { runPipelineNow } from "@/app/actions";
import { LocalTime } from "@/components/LocalTime";
import { sourceKind } from "@/lib/source-rank";

export const dynamic = "force-dynamic";

function fmtTokens(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v === 0) return "-";
  if (v < 1_000) return String(v);
  if (v < 1_000_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number | null | undefined): string {
  const v = Number(usd ?? 0);
  if (v === 0) return "-";
  if (v < 0.01) return `<$0.01`;
  return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: 12, border: "1px solid #ccc4", borderRadius: 8, background: "#fafafa" }}>
      <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{value}</div>
      {sub && <div className="meta" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function fmtDuration(start: Date, end: Date | null | undefined): string {
  if (!end) return "-";
  const ms = +end - +start;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export default async function Runs() {
  const user = await requireUser();
  const runs = await db
    .select()
    .from(schema.digestRuns)
    .where(eq(schema.digestRuns.userId, user.id))
    .orderBy(desc(schema.digestRuns.startedAt))
    .limit(50);

  const totalCost = runs.reduce((acc, r) => acc + Number(r.costUsd ?? 0), 0);

  const inFlight = runs.find((r) => !r.finishedAt);

  // Rolling windows over what was fetched (capped at 50 rows). Adequate for
  // typical daily-cron usage where 50 runs ≈ 2 months; we'd widen the limit
  // before this misleads anyone.
  const now = Date.now();
  const last7 = runs.filter((r) => now - +r.startedAt < 7 * 86400_000);
  const last30 = runs.filter((r) => now - +r.startedAt < 30 * 86400_000);
  const sum = (arr: typeof runs, k: keyof typeof runs[number]) => arr.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const cost7 = sum(last7, "costUsd");
  const cost30 = sum(last30, "costUsd");
  const matches30 = sum(last30, "matchesCreated");
  const avgPerMatch = matches30 > 0 ? cost30 / matches30 : 0;
  const dsIn = sum(last30, "deepseekInputTokens");
  const dsOut = sum(last30, "deepseekOutputTokens");
  const anIn = sum(last30, "anthropicInputTokens");
  const anOut = sum(last30, "anthropicOutputTokens");
  // Rough provider cost split - proportional to (tokens × $/Mtok) from local
  // pricing table. Approximate since the canonical figure is each run's
  // pre-summed costUsd; here we just want to show DeepSeek-vs-Anthropic share.
  const dsCost = (dsIn / 1_000_000) * 0.27 + (dsOut / 1_000_000) * 1.10;
  const anCost = (anIn / 1_000_000) * 3.0 + (anOut / 1_000_000) * 15.0;
  const providerTotal = dsCost + anCost;
  const dsShare = providerTotal > 0 ? Math.round((dsCost / providerTotal) * 100) : 0;

  // Per-source breakdown over the last 30d. Candidates + matches joined by
  // source/sourceKind so we can compute "how many candidates this source
  // produced and how many of those became matches" - the conversion rate
  // tells us which sources actually earn their keep.
  const thirty = new Date(Date.now() - 30 * 86400_000);
  const candBySource = await db
    .select({ source: schema.candidates.source, c: sql<number>`count(*)` })
    .from(schema.candidates)
    .where(and(eq(schema.candidates.userId, user.id), gte(schema.candidates.fetchedAt, thirty)))
    .groupBy(schema.candidates.source);
  const matchBySource = await db
    .select({ kind: schema.matches.sourceKind, c: sql<number>`count(*)`, fb: sql<number>`sum(case when ${schema.matches.userFeedback} = 'good' then 1 when ${schema.matches.userFeedback} = 'bad' then -1 else 0 end)` })
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, user.id), gte(schema.matches.createdAt, thirty), isNotNull(schema.matches.sourceKind)))
    .groupBy(schema.matches.sourceKind);
  const candByKind = new Map<string, number>();
  for (const r of candBySource) {
    const k = sourceKind(r.source);
    candByKind.set(k, (candByKind.get(k) ?? 0) + Number(r.c ?? 0));
  }
  const matchKindAgg = new Map<string, { matches: number; net: number }>();
  for (const r of matchBySource) {
    if (!r.kind) continue;
    matchKindAgg.set(r.kind, { matches: Number(r.c ?? 0), net: Number(r.fb ?? 0) });
  }
  const sourceRows = [...new Set([...candByKind.keys(), ...matchKindAgg.keys()])]
    .map((k) => ({
      kind: k,
      candidates: candByKind.get(k) ?? 0,
      matches: matchKindAgg.get(k)?.matches ?? 0,
      net: matchKindAgg.get(k)?.net ?? 0,
    }))
    .sort((a, b) => b.matches - a.matches);

  return (
    <>
      <h1>Runs</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, margin: "12px 0 20px" }}>
        <Card label="last 7 days" value={fmtCost(cost7)} sub={`${last7.length} runs`} />
        <Card label="last 30 days" value={fmtCost(cost30)} sub={`${last30.length} runs · ${matches30} matches`} />
        <Card label="avg / match" value={avgPerMatch > 0 ? fmtCost(avgPerMatch) : "-"} sub="over 30d" />
        <Card label="provider mix (30d)" value={providerTotal > 0 ? `${dsShare}% DS · ${100 - dsShare}% AN` : "-"} sub={fmtCost(providerTotal)} />
      </div>

      {sourceRows.length > 0 && (
        <details open style={{ margin: "0 0 18px" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14, color: "#444" }}>Source breakdown (30d)</summary>
          <table style={{ marginTop: 8, fontSize: 13 }}>
            <thead>
              <tr>
                <th>source</th>
                <th style={{ textAlign: "right" }}>candidates</th>
                <th style={{ textAlign: "right" }}>matches</th>
                <th style={{ textAlign: "right" }}>convert</th>
                <th style={{ textAlign: "right" }}>net 👍−👎</th>
              </tr>
            </thead>
            <tbody>
              {sourceRows.map((s) => {
                const rate = s.candidates > 0 ? Math.round((s.matches / s.candidates) * 1000) / 10 : 0;
                return (
                  <tr key={s.kind}>
                    <td>{s.kind}</td>
                    <td style={{ textAlign: "right" }}>{s.candidates}</td>
                    <td style={{ textAlign: "right" }}>{s.matches}</td>
                    <td style={{ textAlign: "right", color: rate > 5 ? "#1f8a4c" : rate < 1 ? "#a96" : undefined }}>{s.candidates > 0 ? `${rate}%` : "-"}</td>
                    <td style={{ textAlign: "right", color: s.net > 0 ? "#1f8a4c" : s.net < 0 ? "#c00" : "#888" }}>{s.net > 0 ? `+${s.net}` : s.net}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
      <p className="meta">
        Showing last {runs.length} runs · total in view: {fmtCost(totalCost)}. Token counts come from each provider's API
        response; cost is computed from a local pricing table (cross-check{" "}
        <a href="https://artificialanalysis.ai/leaderboards/models" target="_blank" rel="noreferrer">artificialanalysis.ai</a>).
      </p>
      <form action={runPipelineNow} style={{ margin: "8px 0 16px" }}>
        <button type="submit" disabled={!!inFlight}>
          {inFlight ? `running (started ${inFlight.startedAt.toISOString().slice(11, 16)})…` : "Run pipeline now"}
        </button>
        {!inFlight && <span className="meta" style={{ marginLeft: 8 }}>fetches new candidates, analyzes, sends digest email · 5-10 min</span>}
      </form>
      <table>
        <thead>
          <tr>
            <th>started</th>
            <th>dur</th>
            <th style={{ textAlign: "right" }}>candidates</th>
            <th style={{ textAlign: "right" }}>analyzed</th>
            <th style={{ textAlign: "right" }}>matches</th>
            <th style={{ textAlign: "center" }}>email</th>
            <th style={{ textAlign: "right" }}>DS in / out</th>
            <th style={{ textAlign: "right" }}>AN in / out</th>
            <th style={{ textAlign: "right" }}>cost</th>
            <th>error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="meta" style={{ whiteSpace: "nowrap" }}>
                <LocalTime iso={r.startedAt.toISOString()} />
              </td>
              <td className="meta">{fmtDuration(r.startedAt, r.finishedAt)}</td>
              <td style={{ textAlign: "right" }}>{r.candidatesFound ?? 0}</td>
              <td style={{ textAlign: "right" }}>{r.reposAnalyzed ?? 0}</td>
              <td style={{ textAlign: "right" }}>{r.matchesCreated ?? 0}</td>
              <td style={{ textAlign: "center" }}>{r.emailSent ? "✓" : "-"}</td>
              <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {fmtTokens(r.deepseekInputTokens)} / {fmtTokens(r.deepseekOutputTokens)}
              </td>
              <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {fmtTokens(r.anthropicInputTokens)} / {fmtTokens(r.anthropicOutputTokens)}
              </td>
              <td style={{ textAlign: "right" }}>{fmtCost(r.costUsd)}</td>
              <td className="meta">{r.errorLog ? "yes" : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
