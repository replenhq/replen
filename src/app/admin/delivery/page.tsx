import { db, schema } from "@/db/client";
import { desc, gte, sql } from "drizzle-orm";
import { requireAdmin2fa } from "@/lib/admin/2fa";

export const dynamic = "force-dynamic";

// Delivery status. The Brief (weekly email) is the paid anchor and Critical
// alerts are the urgent lane — this answers "did they actually go out, to whom,
// and this week?" straight off brief_log + alert_log.

export default async function DeliveryAdmin() {
  await requireAdmin2fa();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const briefs = await db.select().from(schema.briefLog).orderBy(desc(schema.briefLog.sentAt)).limit(30);
  const alerts = await db.select().from(schema.alertLog).orderBy(desc(schema.alertLog.sentAt)).limit(30);

  const briefs7 = await db.select({ c: sql<number>`count(*)` }).from(schema.briefLog).where(gte(schema.briefLog.sentAt, weekAgo)).get();
  const alerts7 = await db.select({ c: sql<number>`count(*)` }).from(schema.alertLog).where(gte(schema.alertLog.sentAt, weekAgo)).get();

  const latestWeek = briefs[0]?.weekKey ?? null;
  const briefsThisWeek = latestWeek ? briefs.filter((b) => b.weekKey === latestWeek).length : 0;

  const userIds = [...new Set([...briefs.map((b) => b.userId), ...alerts.map((a) => a.userId)])];
  const emailById = new Map<number, string>();
  for (const id of userIds) {
    const u = await db.select({ email: schema.users.email }).from(schema.users).where(sql`${schema.users.id} = ${id}`).get();
    if (u) emailById.set(id, u.email);
  }

  return (
    <>
      <h1>Delivery status</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, maxWidth: 640, marginTop: 12 }}>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border,#ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Briefs this week</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{briefsThisWeek}</div>
          <div className="meta" style={{ fontSize: 11, marginTop: 2 }}>{latestWeek ?? "none yet"}</div>
        </div>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border,#ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Briefs (7d)</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{Number(briefs7?.c ?? 0)}</div>
        </div>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border,#ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Alerts fired (7d)</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{Number(alerts7?.c ?? 0)}</div>
        </div>
      </div>

      <h2 style={{ marginTop: 28 }}>Recent Brief sends</h2>
      {briefs.length === 0 && <p className="meta">No Briefs sent yet.</p>}
      {briefs.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Sent</th><th>User</th><th>Week</th></tr></thead>
            <tbody>
              {briefs.map((b) => (
                <tr key={b.id}>
                  <td className="meta">{b.sentAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="meta">{emailById.get(b.userId) ?? `#${b.userId}`}</td>
                  <td>{b.weekKey}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 28 }}>Recent Critical alerts</h2>
      {alerts.length === 0 && <p className="meta">No alerts fired yet.</p>}
      {alerts.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Sent</th><th>User</th><th>Channel</th><th>Event</th></tr></thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td className="meta">{a.sentAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="meta">{emailById.get(a.userId) ?? `#${a.userId}`}</td>
                  <td><span className="tag">{a.channel}</span></td>
                  <td className="meta">#{a.eventId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
