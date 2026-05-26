import { db, schema } from "@/db/client";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { sendInviteEmail } from "@/email/invite";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireAdmin();
  const users = await db.select().from(schema.users).orderBy(desc(schema.users.createdAt));

  // Signup tracker: rolling counts + daily cap state. The cap matters
  // on launch days when /api/login starts refusing new accounts once
  // hit. Computed against the same "verified email created in last
  // 24h" window that current-user.ts:getCurrentUser uses.
  const now = Date.now();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const signupsToday = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.users)
    .where(gte(schema.users.createdAt, oneDayAgo))
    .get();
  const signupsWeek = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.users)
    .where(gte(schema.users.createdAt, oneWeekAgo))
    .get();
  const todayCount = Number(signupsToday?.c ?? 0);
  const weekCount = Number(signupsWeek?.c ?? 0);
  const totalCount = users.length;
  const dailyCap = parseInt(process.env.REPLEN_DAILY_SIGNUP_CAP ?? "50", 10);
  const capPct = Math.min(100, Math.round((todayCount / dailyCap) * 100));
  const capState: "ok" | "warn" | "hit" = capPct >= 100 ? "hit" : capPct >= 80 ? "warn" : "ok";

  async function addUser(form: FormData) {
    "use server";
    const adminUser = await requireAdmin();
    const rawEmail = (form.get("email") as string || "").trim();
    if (!rawEmail) return;
    const email = rawEmail.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid email");
    const placeholder = `invited:${email}`;
    const result = await db
      .insert(schema.users)
      .values({
        firebaseUid: placeholder,
        email,
        role: "user",
        status: "active",
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.users.email });
    revalidatePath("/admin");
    // Only send the invite when the row was newly created - re-clicking "Add"
    // for an existing email shouldn't spam them.
    if (result.rowsAffected > 0) {
      void sendInviteEmail(email, adminUser.email).catch((e) =>
        console.error("[admin addUser] invite send failed", e)
      );
    }
  }

  async function resendInvite(email: string) {
    "use server";
    const adminUser = await requireAdmin();
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    await sendInviteEmail(email, adminUser.email);
  }

  async function setRole(userId: number, role: "admin" | "user") {
    "use server";
    await requireAdmin();
    if (role !== "admin" && role !== "user") throw new Error("invalid role");
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    // Don't let the last admin demote themselves to "user" - locks the org out.
    // Same applies to suspending or deleting the last admin (see setStatus).
    if (role === "user") {
      const target = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      if (target?.role === "admin") {
        const otherAdminCount = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")));
        const remaining = otherAdminCount.filter((u) => u.id !== userId).length;
        if (remaining === 0) throw new Error("refusing to demote the last active admin");
      }
    }
    await db.update(schema.users).set({ role }).where(eq(schema.users.id, userId));
    revalidatePath("/admin");
  }

  async function setStatus(userId: number, status: "active" | "pending" | "suspended") {
    "use server";
    await requireAdmin();
    if (status !== "active" && status !== "pending" && status !== "suspended") throw new Error("invalid status");
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    if (status !== "active") {
      const target = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      if (target?.role === "admin") {
        const activeAdmins = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")));
        const remaining = activeAdmins.filter((u) => u.id !== userId).length;
        if (remaining === 0) throw new Error("refusing to deactivate the last active admin");
      }
    }
    await db.update(schema.users).set({ status }).where(eq(schema.users.id, userId));
    revalidatePath("/admin");
  }

  async function setSharedLlm(userId: number, value: boolean) {
    "use server";
    await requireAdmin();
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    await db.update(schema.users).set({ canUseSharedLlm: value }).where(eq(schema.users.id, userId));
    revalidatePath("/admin");
  }

  const pendingCount = await db
    .select({ c: schema.proposedSources.id })
    .from(schema.proposedSources)
    .where(eq(schema.proposedSources.status, "pending"));

  const pendingUsers = users.filter((u) => u.status === "pending");

  return (
    <>
      <h1>Admin</h1>

      {pendingUsers.length > 0 && (
        <div style={{ marginTop: 16, padding: "10px 14px", background: "#fff7e0", border: "1px solid #e0c060", borderRadius: 6 }}>
          <strong>{pendingUsers.length} {pendingUsers.length === 1 ? "account" : "accounts"} awaiting approval:</strong>{" "}
          {pendingUsers.map((u) => u.email).join(", ")} — see the <a href="#users">Users table</a> below to approve or reject.
        </div>
      )}

      <p style={{ marginTop: 12 }}>
        <a href="/admin/proposals">Source proposals queue ({pendingCount.length} pending)</a>
        {" · "}
        <a href="/projects">Projects (sensitivity / model overrides)</a>
        {" · "}
        <a href="/admin/errors">Recent errors</a>
      </p>

      <h2 style={{ marginTop: 24 }}>Signups</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, maxWidth: 720 }}>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border, #ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Today (24h)</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{todayCount}</div>
          <div className="meta" style={{ fontSize: 11, marginTop: 4 }}>
            <span style={{ color: capState === "hit" ? "#b91c1c" : capState === "warn" ? "#92400e" : "var(--faint, #888)" }}>
              {capPct}% of cap ({dailyCap})
            </span>
          </div>
        </div>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border, #ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>This week</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{weekCount}</div>
        </div>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border, #ddd)", borderRadius: 6 }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>All time</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{totalCount}</div>
        </div>
        <div style={{ padding: "10px 14px", border: "1px solid var(--border, #ddd)", borderRadius: 6, background: capState === "hit" ? "rgba(239,68,68,0.08)" : capState === "warn" ? "rgba(217,119,6,0.08)" : "transparent" }}>
          <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Cap state</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4, color: capState === "hit" ? "#b91c1c" : capState === "warn" ? "#92400e" : "var(--fg)" }}>
            {capState === "hit" ? "🚫 Hit — signups blocked" : capState === "warn" ? "⚠️ Near cap" : "✓ Healthy"}
          </div>
          <div className="meta" style={{ fontSize: 11, marginTop: 4 }}>
            <code>REPLEN_DAILY_SIGNUP_CAP={dailyCap}</code>
          </div>
        </div>
      </div>

      <h2 style={{ marginTop: 24 }}>Add user</h2>
      <p className="meta">
        Enter the email of someone you want to grant access. They sign in via Firebase Auth at /login; on first sign-in their row is upgraded with their Firebase UID.
      </p>
      <form action={addUser} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input name="email" type="email" placeholder="friend@example.com" required style={{ padding: 6, minWidth: 280 }} />
        <button type="submit">Add</button>
      </form>

      <h2 id="users" style={{ marginTop: 32 }}>Users</h2>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Shared LLM</th>
            <th>Last login</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{u.status}</td>
              <td>
                <form className="inline" action={async () => { "use server"; await setSharedLlm(u.id, !u.canUseSharedLlm); }}>
                  <button style={u.canUseSharedLlm ? { background: "#a4d8a4", color: "#1a1a1a" } : undefined}>
                    {u.canUseSharedLlm ? "✓ allowed" : "-"}
                  </button>
                </form>
              </td>
              <td className="meta">{u.lastLoginAt?.toISOString().slice(0, 16) ?? "(never)"}</td>
              <td className="meta">{u.createdAt.toISOString().slice(0, 10)}</td>
              <td>
                <form className="inline" action={async () => { "use server"; await setRole(u.id, u.role === "admin" ? "user" : "admin"); }}>
                  <button>{u.role === "admin" ? "→ user" : "→ admin"}</button>
                </form>
                {u.status === "pending" ? (
                  <>
                    <form className="inline" action={async () => { "use server"; await setStatus(u.id, "active"); }}>
                      <button style={{ background: "#a4d8a4", color: "#1a1a1a", fontWeight: 600 }} title="Approve this account">approve</button>
                    </form>
                    <form className="inline" action={async () => { "use server"; await setStatus(u.id, "suspended"); }}>
                      <button title="Reject this account">reject</button>
                    </form>
                  </>
                ) : (
                  <form className="inline" action={async () => { "use server"; await setStatus(u.id, u.status === "active" ? "suspended" : "active"); }}>
                    <button>{u.status === "active" ? "suspend" : "unsuspend"}</button>
                  </form>
                )}
                {u.firebaseUid.startsWith("invited:") && (
                  <form className="inline" action={async () => { "use server"; await resendInvite(u.email); }}>
                    <button title="Re-send the invite email">resend invite</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
