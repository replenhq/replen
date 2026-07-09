import { db, schema } from "@/db/client";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { sendInviteEmail } from "@/email/invite";
import { recordAdminAction } from "@/lib/admin/audit";
import { deleteUserAndAllData } from "@/lib/account-delete";
import { ConfirmButton } from "./ConfirmButton";

export const dynamic = "force-dynamic";

const count = async (q: Promise<{ c: number } | undefined>) => Number((await q)?.c ?? 0);

export default async function AdminPage() {
  await requireAdmin();
  const users = await db.select().from(schema.users).orderBy(desc(schema.users.createdAt));

  // Signup tracker: rolling counts + daily cap state. The cap matters
  // on launch days when /api/login starts refusing new accounts once
  // hit. Computed against the same "verified email created in last
  // 24h" window that current-user.ts:getCurrentUser uses.
  const now = Date.now();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const todayCount = await count(db.select({ c: sql<number>`count(*)` }).from(schema.users).where(gte(schema.users.createdAt, oneDayAgo)).get());
  const weekCount = await count(db.select({ c: sql<number>`count(*)` }).from(schema.users).where(gte(schema.users.createdAt, oneWeekAgo)).get());
  const totalCount = users.length;
  const dailyCap = parseInt(process.env.REPLEN_DAILY_SIGNUP_CAP ?? "50", 10);
  const capPct = Math.min(100, Math.round((todayCount / dailyCap) * 100));
  const capState: "ok" | "warn" | "hit" = capPct >= 100 ? "hit" : capPct >= 80 ? "warn" : "ok";

  // Anonymised aggregate telemetry — no per-user code, just pool sizes so the
  // operator can see the service is warming (users active, repos watched,
  // candidate pool, matches surfaced).
  const activeUsers = users.filter((u) => u.status === "active").length;
  const projectCount = await count(db.select({ c: sql<number>`count(*)` }).from(schema.projectProfiles).get());
  const candidatePool = await count(db.select({ c: sql<number>`count(*)` }).from(schema.candidates).get());
  const matchCount = await count(db.select({ c: sql<number>`count(*)` }).from(schema.matches).get());

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
      .values({ firebaseUid: placeholder, email, role: "user", status: "active", createdAt: new Date() })
      .onConflictDoNothing({ target: schema.users.email });
    revalidatePath("/admin");
    // Only send the invite when the row was newly created - re-clicking "Add"
    // for an existing email shouldn't spam them.
    if (result.rowsAffected > 0) {
      void sendInviteEmail(email, adminUser.email).catch((e) => console.error("[admin addUser] invite send failed", e));
      await recordAdminAction({ actorId: adminUser.id, actorEmail: adminUser.email, action: "user.invite", targetType: "user", targetLabel: email });
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
    const adminUser = await requireAdmin();
    if (role !== "admin" && role !== "user") throw new Error("invalid role");
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    const target = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!target) return;
    // Don't let the last admin demote themselves to "user" - locks the org out.
    // Same applies to suspending or deleting the last admin (see setStatus).
    if (role === "user" && target.role === "admin") {
      const admins = await db.select({ id: schema.users.id }).from(schema.users)
        .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")));
      if (admins.filter((u) => u.id !== userId).length === 0) throw new Error("refusing to demote the last active admin");
    }
    await db.update(schema.users).set({ role }).where(eq(schema.users.id, userId));
    revalidatePath("/admin");
    await recordAdminAction({ actorId: adminUser.id, actorEmail: adminUser.email, action: "user.role.set", targetType: "user", targetId: userId, targetLabel: target.email, meta: { from: target.role, to: role } });
  }

  async function setStatus(userId: number, status: "active" | "pending" | "suspended") {
    "use server";
    const adminUser = await requireAdmin();
    if (status !== "active" && status !== "pending" && status !== "suspended") throw new Error("invalid status");
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    const target = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!target) return;
    if (status !== "active" && target.role === "admin") {
      const admins = await db.select({ id: schema.users.id }).from(schema.users)
        .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")));
      if (admins.filter((u) => u.id !== userId).length === 0) throw new Error("refusing to deactivate the last active admin");
    }
    await db.update(schema.users).set({ status }).where(eq(schema.users.id, userId));
    revalidatePath("/admin");
    await recordAdminAction({ actorId: adminUser.id, actorEmail: adminUser.email, action: "user.status.set", targetType: "user", targetId: userId, targetLabel: target.email, meta: { from: target.status, to: status } });
  }

  async function setSharedLlm(userId: number, value: boolean) {
    "use server";
    const adminUser = await requireAdmin();
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    const target = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).get();
    await db.update(schema.users).set({ canUseSharedLlm: value }).where(eq(schema.users.id, userId));
    revalidatePath("/admin");
    await recordAdminAction({ actorId: adminUser.id, actorEmail: adminUser.email, action: "user.shared_llm.set", targetType: "user", targetId: userId, targetLabel: target?.email, meta: { value } });
  }

  // GDPR / erasure: run the account-delete sweep for a user. Confirm-gated in
  // the UI (ConfirmButton) and last-admin-guarded here — never delete the final
  // active admin.
  async function deleteAccount(userId: number) {
    "use server";
    const adminUser = await requireAdmin();
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    const target = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!target) return;
    if (target.role === "admin") {
      const admins = await db.select({ id: schema.users.id }).from(schema.users)
        .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")));
      if (admins.filter((u) => u.id !== userId).length === 0) throw new Error("refusing to delete the last active admin");
    }
    await deleteUserAndAllData(userId);
    await recordAdminAction({ actorId: adminUser.id, actorEmail: adminUser.email, action: "account.delete", targetType: "account", targetId: userId, targetLabel: target.email });
    revalidatePath("/admin");
  }

  const pendingCount = await db.select({ c: schema.proposedSources.id }).from(schema.proposedSources).where(eq(schema.proposedSources.status, "pending"));
  const pendingUsers = users.filter((u) => u.status === "pending");

  const statCard = (label: string, value: number | string, extra?: React.ReactNode, bg?: string) => (
    <div style={{ padding: "10px 14px", border: "1px solid var(--border, #ddd)", borderRadius: 6, background: bg ?? "transparent" }}>
      <div className="meta" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {extra}
    </div>
  );

  return (
    <>
      <h1>Users</h1>

      {pendingUsers.length > 0 && (
        <div style={{ marginTop: 16, padding: "10px 14px", background: "#fff7e0", border: "1px solid #e0c060", borderRadius: 6 }}>
          <strong>{pendingUsers.length} {pendingUsers.length === 1 ? "account" : "accounts"} awaiting approval:</strong>{" "}
          {pendingUsers.map((u) => u.email).join(", ")} — see the <a href="#users">Users table</a> below to approve or reject.
        </div>
      )}

      <p style={{ marginTop: 12 }}>
        <a href="/projects">Projects (sensitivity / model overrides)</a>
        {" · "}
        <a href="/admin/proposals">Source proposals ({pendingCount.length} pending)</a>
      </p>

      <h2 style={{ marginTop: 24 }}>Service (aggregate)</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, maxWidth: 720 }}>
        {statCard("Active users", activeUsers)}
        {statCard("Projects watched", projectCount)}
        {statCard("Candidate pool", candidatePool)}
        {statCard("Matches surfaced", matchCount)}
      </div>

      <h2 style={{ marginTop: 24 }}>Signups</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, maxWidth: 720 }}>
        {statCard("Today (24h)", todayCount, (
          <div className="meta" style={{ fontSize: 11, marginTop: 4 }}>
            <span style={{ color: capState === "hit" ? "#b91c1c" : capState === "warn" ? "#92400e" : "var(--faint, #888)" }}>{capPct}% of cap ({dailyCap})</span>
          </div>
        ))}
        {statCard("This week", weekCount)}
        {statCard("All time", totalCount)}
        {statCard(
          "Cap state",
          capState === "hit" ? "🚫" : capState === "warn" ? "⚠️" : "✓",
          <div className="meta" style={{ fontSize: 11, marginTop: 4 }}><code>REPLEN_DAILY_SIGNUP_CAP={dailyCap}</code></div>,
          capState === "hit" ? "rgba(239,68,68,0.08)" : capState === "warn" ? "rgba(217,119,6,0.08)" : "transparent",
        )}
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
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Email</th><th>Role</th><th>Status</th><th>Shared LLM</th><th>Last login</th><th>Created</th><th>Actions</th>
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
                    <button style={u.canUseSharedLlm ? { background: "#a4d8a4", color: "#1a1a1a" } : undefined}>{u.canUseSharedLlm ? "✓ allowed" : "-"}</button>
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
                  <form className="inline" action={async () => { "use server"; await deleteAccount(u.id); }}>
                    <ConfirmButton message={`Permanently delete ${u.email} and ALL their data (repos, matches, graph)? This cannot be undone.`} style={{ color: "#b91c1c" }} title="GDPR erasure — deletes the account and all owned data">delete</ConfirmButton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
