import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db/client";
import { requireAdmin } from "@/lib/auth/current-user";
import { admin2faVerified, hasEnrolledFactor, mintAdmin2fa } from "@/lib/admin/2fa";
import { verifyTotp } from "@/lib/admin/totp";
import { recordAdminAction } from "@/lib/admin/audit";
import { PasskeyButton } from "./PasskeyButton";

export const dynamic = "force-dynamic";

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const admin = await requireAdmin();
  // Already verified → nothing to do. Not enrolled → must set up first.
  if (await admin2faVerified(admin.id)) redirect("/admin");
  if (!(await hasEnrolledFactor(admin.id))) redirect("/admin/security");

  const { err } = await searchParams;
  const totp = await db.select().from(schema.adminTotp).where(eq(schema.adminTotp.userId, admin.id)).get();
  const totpConfirmed = !!totp?.confirmedAt;
  const passkeyCount = (await db.select({ id: schema.adminPasskeys.id }).from(schema.adminPasskeys).where(eq(schema.adminPasskeys.userId, admin.id))).length;

  async function verifyCode(form: FormData) {
    "use server";
    const a = await requireAdmin();
    const row = await db.select().from(schema.adminTotp).where(eq(schema.adminTotp.userId, a.id)).get();
    if (!row?.confirmedAt || !verifyTotp(row.secret, String(form.get("code") ?? ""))) {
      redirect("/admin/verify?err=1");
    }
    await mintAdmin2fa(a.id);
    await recordAdminAction({ actorId: a.id, actorEmail: a.email, action: "admin.2fa.pass", targetType: "account", targetId: a.id, targetLabel: `${a.email} (totp)` });
    redirect("/admin");
  }

  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Verify it&rsquo;s you</h1>
      <p className="meta">A second factor is required to open the admin panel.</p>

      {passkeyCount > 0 && (
        <div style={{ marginTop: 20 }}>
          <PasskeyButton />
        </div>
      )}

      {passkeyCount > 0 && totpConfirmed && (
        <div style={{ margin: "20px 0", color: "var(--faint,#888)", fontSize: 12 }}>— or use a code —</div>
      )}

      {totpConfirmed && (
        <form action={verifyCode} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: passkeyCount > 0 ? 0 : 20 }}>
          <input name="code" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="123456" required autoFocus={passkeyCount === 0} style={{ padding: 8, width: 130, fontSize: 18, letterSpacing: "0.2em" }} />
          <button type="submit" style={{ padding: "8px 16px" }}>Verify</button>
        </form>
      )}

      {err && <p style={{ color: "#c33", fontSize: 13, marginTop: 14 }}>That code didn&rsquo;t match. Try again.</p>}
    </div>
  );
}
