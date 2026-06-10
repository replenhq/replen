import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { addQueueItem, resolveQueueItem } from "./actions";

export const dynamic = "force-dynamic";

// The queue — work waiting for a coding session. Items arrive from brief /
// alert email links, the Atlas dossiers, past sessions (replen_queue), or the
// form below. Routing: an item with a project only surfaces in sessions
// scoped to that project; project-less items surface anywhere.
export default async function QueuePage() {
  const user = await requireUser();
  const [pending, recent, projects] = await Promise.all([
    db.select().from(schema.queuedActions)
      .where(and(eq(schema.queuedActions.userId, user.id), eq(schema.queuedActions.status, "queued")))
      .orderBy(schema.queuedActions.createdAt),
    db.select().from(schema.queuedActions)
      .where(eq(schema.queuedActions.userId, user.id))
      .orderBy(desc(schema.queuedActions.resolvedAt)).limit(50),
    db.select({ slug: schema.projectProfiles.slug }).from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.active, true), eq(schema.projectProfiles.included, true)))
      .orderBy(schema.projectProfiles.slug),
  ]);
  const resolved = recent.filter((r) => r.status !== "queued").slice(0, 12);
  const fmt = (d: Date | null) => d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";

  return (
    <main>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Queue</h1>
      <p style={{ color: "var(--dim, #a3a3a3)", marginTop: 0 }}>
        Work waiting for a coding session. Items with a project surface only when you're in that repo; the rest surface anywhere.
        Your agent offers the oldest item once a day until it's done or dismissed.
      </p>

      <form action={addQueueItem} style={{ display: "flex", gap: 8, margin: "18px 0 26px", flexWrap: "wrap" }}>
        <input name="title" placeholder="queue something… (e.g. swap pdfkit for typst in british-housing)" required
          style={{ flex: "1 1 320px", background: "rgba(255,255,255,0.06)", border: "1px solid var(--border, #333)", borderRadius: 6, color: "inherit", padding: "8px 12px", fontSize: 14 }} />
        <select name="project" defaultValue="" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid var(--border, #333)", borderRadius: 6, color: "inherit", padding: "8px 10px", fontSize: 14 }}>
          <option value="">any repo</option>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
        </select>
        <button type="submit" style={{ background: "rgba(34,211,238,0.12)", border: "1px solid #155e6b", color: "#67e8f9", borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontSize: 14 }}>Queue</button>
      </form>

      <h2 style={{ fontSize: 15, color: "var(--dim, #a3a3a3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Pending ({pending.length})</h2>
      {pending.length === 0 && <p style={{ color: "var(--dim, #777)" }}>Nothing queued — the calm state.</p>}
      {pending.map((q) => (
        <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border, #222)" }}>
          <div style={{ flex: 1 }}>
            <div>{q.title}</div>
            <div style={{ fontSize: 12, color: "var(--dim, #888)" }}>
              {q.projectSlug ? `for ${q.projectSlug}` : "any repo"} · queued {fmt(q.createdAt)} · {q.kind}
              {q.note ? ` · ${q.note}` : ""}
            </div>
          </div>
          <form action={resolveQueueItem}>
            <input type="hidden" name="id" value={q.id} />
            <input type="hidden" name="outcome" value="done" />
            <button type="submit" style={{ background: "none", border: "1px solid #14532d", color: "#86efac", borderRadius: 5, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>done</button>
          </form>
          <form action={resolveQueueItem}>
            <input type="hidden" name="id" value={q.id} />
            <input type="hidden" name="outcome" value="dismissed" />
            <button type="submit" style={{ background: "none", border: "1px solid #444", color: "#aaa", borderRadius: 5, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>dismiss</button>
          </form>
        </div>
      ))}

      {resolved.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, color: "var(--dim, #a3a3a3)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 32 }}>Recently resolved</h2>
          {resolved.map((q) => (
            <div key={q.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border, #1c1c1c)", color: "var(--dim, #999)", fontSize: 14 }}>
              <span style={{ color: q.status === "done" ? "#86efac" : "#888", marginRight: 8 }}>{q.status}</span>
              {q.title}
              <span style={{ fontSize: 12, marginLeft: 8 }}>{fmt(q.resolvedAt)}</span>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
