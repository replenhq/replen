import { db, schema } from "@/db/client";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function ProposalsAdmin() {
  await requireAdmin();

  const pending = await db
    .select()
    .from(schema.proposedSources)
    .where(eq(schema.proposedSources.status, "pending"))
    .orderBy(desc(schema.proposedSources.createdAt));

  const recent = await db
    .select()
    .from(schema.proposedSources)
    .where(and(eq(schema.proposedSources.status, "approved"))) // single-column where for type safety
    .orderBy(desc(schema.proposedSources.reviewedAt))
    .limit(20);

  // Map user_id -> email for display
  const userIds = [...new Set([...pending.map((p) => p.userId), ...recent.map((p) => p.userId)])];
  const userMap = new Map<number, string>();
  for (const id of userIds) {
    const u = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id)).get();
    if (u) userMap.set(id, u.email);
  }

  async function approve(id: number, note: string | null) {
    "use server";
    const admin = await requireAdmin();
    const prop = await db.select().from(schema.proposedSources).where(eq(schema.proposedSources.id, id)).get();
    if (!prop) return;
    // Promote to curated_sources (idempotent on uniq index).
    await db
      .insert(schema.curatedSources)
      .values({
        kind: prop.kind,
        value: prop.value,
        addedByUserId: admin.id,
        proposalId: prop.id,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: [schema.curatedSources.kind, schema.curatedSources.value] });
    await db
      .update(schema.proposedSources)
      .set({ status: "approved", reviewedByUserId: admin.id, reviewedAt: new Date(), adminNote: note })
      .where(eq(schema.proposedSources.id, id));
    revalidatePath("/admin/proposals");
    revalidatePath("/sources");
  }

  async function reject(id: number, note: string | null) {
    "use server";
    const admin = await requireAdmin();
    await db
      .update(schema.proposedSources)
      .set({ status: "rejected", reviewedByUserId: admin.id, reviewedAt: new Date(), adminNote: note })
      .where(eq(schema.proposedSources.id, id));
    revalidatePath("/admin/proposals");
    revalidatePath("/sources");
  }

  return (
    <>
      <p><a href="/admin">← admin</a></p>
      <h1>Proposal queue</h1>

      <h2 style={{ marginTop: 24 }}>Pending</h2>
      {pending.length === 0 && <p className="meta">Inbox zero.</p>}
      {pending.map((p) => (
        <div key={p.id} style={{ border: "1px solid #ccc4", padding: 12, margin: "8px 0", borderRadius: 4 }}>
          <div>
            <span className="tag">{p.kind}</span>{" "}
            <code style={{ fontSize: 14 }}>{p.value}</code>
            {" — proposed by "}<b>{userMap.get(p.userId) ?? "unknown"}</b>{" · "}
            <span className="meta">{p.createdAt.toISOString().slice(0, 16)}</span>
          </div>
          {p.note && <p style={{ margin: "8px 0", fontStyle: "italic" }}>"{p.note}"</p>}
          <form action={async (form) => {
            "use server";
            await approve(p.id, ((form.get("note") as string) || "").trim() || null);
          }} style={{ display: "inline-flex", gap: 6, marginRight: 8 }}>
            <input name="note" placeholder="admin note (optional)" style={{ padding: 4, fontSize: 12 }} />
            <button>Approve → curated</button>
          </form>
          <form action={async (form) => {
            "use server";
            await reject(p.id, ((form.get("note") as string) || "").trim() || null);
          }} style={{ display: "inline-flex", gap: 6 }}>
            <input name="note" placeholder="reason (optional)" style={{ padding: 4, fontSize: 12 }} />
            <button>Reject</button>
          </form>
        </div>
      ))}

      <h2 style={{ marginTop: 32 }}>Recently approved</h2>
      {recent.length === 0 && <p className="meta">Nothing yet.</p>}
      {recent.length > 0 && (
        <ul>
          {recent.map((p) => (
            <li key={p.id}>
              <span className="tag">{p.kind}</span> <code>{p.value}</code>{" "}
              <span className="meta">by {userMap.get(p.userId) ?? "?"} · {p.reviewedAt?.toISOString().slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

void and;
