import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db/client";
import { requireAdmin } from "@/lib/auth/current-user";
import { admin2faVerified, hasEnrolledFactor, mintAdmin2fa } from "@/lib/admin/2fa";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "@/lib/admin/totp";
import { listPasskeys, deletePasskey } from "@/lib/admin/webauthn";
import { recordAdminAction } from "@/lib/admin/audit";
import { PasskeyEnroll } from "./PasskeyEnroll";

export const dynamic = "force-dynamic";

// Managing factors is itself sensitive: once ANY factor is enrolled, adding or
// removing one requires having passed 2FA this session (else a stolen Firebase
// session could enrol an attacker's own factor). Before the first factor
// exists, we allow bootstrap with just the admin session.
async function guardManage() {
  const admin = await requireAdmin();
  if ((await hasEnrolledFactor(admin.id)) && !(await admin2faVerified(admin.id))) {
    redirect("/admin/verify");
  }
  return admin;
}

export default async function SecurityPage() {
  const admin = await guardManage();

  const totp = await db.select().from(schema.adminTotp).where(eq(schema.adminTotp.userId, admin.id)).get();
  const passkeys = await listPasskeys(admin.id);
  const totpConfirmed = !!totp?.confirmedAt;

  async function startTotp() {
    "use server";
    const a = await guardManage();
    const secret = generateTotpSecret();
    await db
      .insert(schema.adminTotp)
      .values({ userId: a.id, secret, confirmedAt: null, createdAt: new Date() })
      .onConflictDoUpdate({ target: schema.adminTotp.userId, set: { secret, confirmedAt: null, createdAt: new Date() } });
    revalidatePath("/admin/security");
  }

  async function confirmTotp(form: FormData) {
    "use server";
    const a = await guardManage();
    const row = await db.select().from(schema.adminTotp).where(eq(schema.adminTotp.userId, a.id)).get();
    if (!row) return;
    const code = String(form.get("code") ?? "");
    if (!verifyTotp(row.secret, code)) {
      redirect("/admin/security?totp=bad");
    }
    await db.update(schema.adminTotp).set({ confirmedAt: new Date() }).where(eq(schema.adminTotp.userId, a.id));
    await mintAdmin2fa(a.id);
    await recordAdminAction({ actorId: a.id, actorEmail: a.email, action: "admin.2fa.totp.enroll", targetType: "account", targetId: a.id, targetLabel: a.email });
    redirect("/admin");
  }

  async function resetTotp() {
    "use server";
    const a = await guardManage();
    await db.delete(schema.adminTotp).where(eq(schema.adminTotp.userId, a.id));
    await recordAdminAction({ actorId: a.id, actorEmail: a.email, action: "admin.2fa.totp.reset", targetType: "account", targetId: a.id, targetLabel: a.email });
    revalidatePath("/admin/security");
  }

  async function removePasskey(id: number) {
    "use server";
    const a = await guardManage();
    await deletePasskey(a.id, id);
    await recordAdminAction({ actorId: a.id, actorEmail: a.email, action: "admin.2fa.passkey.remove", targetType: "account", targetId: a.id, targetLabel: `passkey #${id}` });
    revalidatePath("/admin/security");
  }

  const enrolled = totpConfirmed || passkeys.length > 0;

  return (
    <>
      <h1>Security — admin 2FA</h1>
      <p className="meta" style={{ maxWidth: 640 }}>
        Second factor for the admin panel (this account only). A <strong>passkey</strong> (Face / Touch ID) is the primary
        method; a <strong>TOTP</strong> code (Google Authenticator) is the fallback for when you&rsquo;re away from your device.
        Set up at least one. {enrolled ? "" : "You must enrol a factor before the rest of the panel unlocks."}
      </p>

      <h2 style={{ marginTop: 28 }}>Passkeys {passkeys.length > 0 && <span className="meta">({passkeys.length})</span>}</h2>
      {passkeys.length === 0 && <p className="meta">No passkeys registered.</p>}
      {passkeys.length > 0 && (
        <table style={{ maxWidth: 640 }}>
          <thead><tr><th>Device</th><th>Added</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {passkeys.map((p) => (
              <tr key={p.id}>
                <td>{p.label ?? "passkey"}</td>
                <td className="meta">{p.createdAt.toISOString().slice(0, 10)}</td>
                <td className="meta">{p.lastUsedAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"}</td>
                <td>
                  <form className="inline" action={async () => { "use server"; await removePasskey(p.id); }}>
                    <button style={{ color: "#b91c1c" }}>remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 12 }}>
        <PasskeyEnroll />
      </div>

      <h2 style={{ marginTop: 32 }}>Authenticator app (TOTP)</h2>
      {totpConfirmed ? (
        <p>
          <span style={{ color: "#166534", fontWeight: 600 }}>✓ Enabled.</span>{" "}
          <form className="inline" action={resetTotp}>
            <button style={{ color: "#b91c1c" }}>reset</button>
          </form>
        </p>
      ) : totp ? (
        <div style={{ maxWidth: 560 }}>
          <p className="meta">
            In Google Authenticator: <strong>+ → Enter a setup key</strong>. Account: <code>Replen ({admin.email})</code>,
            Key (below), Type: <strong>Time based</strong>. Then enter the 6-digit code to confirm.
          </p>
          <p>
            Setup key:{" "}
            <code style={{ fontSize: 15, letterSpacing: "0.08em", userSelect: "all", background: "var(--surface-1,#f6f6f6)", padding: "3px 8px", borderRadius: 4 }}>
              {totp.secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
          </p>
          <details style={{ margin: "6px 0 12px" }}>
            <summary className="meta">otpauth:// URL (some apps import this directly)</summary>
            <code style={{ fontSize: 11, wordBreak: "break-all" }}>{otpauthUrl(totp.secret, admin.email)}</code>
          </details>
          <form action={confirmTotp} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input name="code" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="123456" required style={{ padding: 6, width: 110, fontSize: 16, letterSpacing: "0.15em" }} />
            <button type="submit">Confirm</button>
          </form>
        </div>
      ) : (
        <form action={startTotp}>
          <button type="submit">Set up authenticator app</button>
        </form>
      )}

      <p style={{ marginTop: 32 }}>
        {enrolled ? <a href="/admin">← back to admin</a> : <span className="meta">Enrol a factor above to continue.</span>}
      </p>
    </>
  );
}
