import { db, schema } from "@/db/client";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { sendInviteEmail } from "@/email/invite";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireAdmin();
  const users = await db.select().from(schema.users).orderBy(desc(schema.users.createdAt));

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
    // Only send the invite when the row was newly created — re-clicking "Add"
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
    // Don't let the last admin demote themselves to "user" — locks the org out.
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

  async function setStatus(userId: number, status: "active" | "suspended") {
    "use server";
    await requireAdmin();
    if (status !== "active" && status !== "suspended") throw new Error("invalid status");
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid userId");
    if (status === "suspended") {
      const target = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      if (target?.role === "admin") {
        const activeAdmins = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")));
        const remaining = activeAdmins.filter((u) => u.id !== userId).length;
        if (remaining === 0) throw new Error("refusing to suspend the last active admin");
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

  return (
    <>
      <h1>Admin</h1>

      <p style={{ marginTop: 12 }}>
        <a href="/admin/proposals">Source proposals queue ({pendingCount.length} pending)</a>
        {" · "}
        <a href="/projects">Projects (sensitivity / model overrides)</a>
      </p>

      <h2 style={{ marginTop: 24 }}>Add user</h2>
      <p className="meta">
        Enter the email of someone you want to grant access. They sign in via Firebase Auth at /login — on first sign-in their row is upgraded with their Firebase UID.
      </p>
      <form action={addUser} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input name="email" type="email" placeholder="friend@example.com" required style={{ padding: 6, minWidth: 280 }} />
        <button type="submit">Add</button>
      </form>

      <h2 style={{ marginTop: 32 }}>Users</h2>
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
                    {u.canUseSharedLlm ? "✓ allowed" : "—"}
                  </button>
                </form>
              </td>
              <td className="meta">{u.lastLoginAt?.toISOString().slice(0, 16) ?? "(never)"}</td>
              <td className="meta">{u.createdAt.toISOString().slice(0, 10)}</td>
              <td>
                <form className="inline" action={async () => { "use server"; await setRole(u.id, u.role === "admin" ? "user" : "admin"); }}>
                  <button>{u.role === "admin" ? "→ user" : "→ admin"}</button>
                </form>
                <form className="inline" action={async () => { "use server"; await setStatus(u.id, u.status === "active" ? "suspended" : "active"); }}>
                  <button>{u.status === "active" ? "suspend" : "unsuspend"}</button>
                </form>
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
