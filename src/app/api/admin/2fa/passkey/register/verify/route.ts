import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { verifyRegistration } from "@/lib/admin/webauthn";
import { mintAdmin2fa } from "@/lib/admin/2fa";
import { recordAdminAction } from "@/lib/admin/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (!body?.response) return NextResponse.json({ error: "missing response" }, { status: 400 });
  const label = typeof body.label === "string" ? body.label : null;
  const verified = await verifyRegistration(user.id, body.response, label);
  if (verified) {
    // The registration ceremony required a user-verification (Face/Touch ID),
    // so treat it as authentication too: mint the session so first-time setup
    // flows straight into /admin without an immediate re-challenge.
    await mintAdmin2fa(user.id);
    await recordAdminAction({ actorId: user.id, actorEmail: user.email, action: "admin.2fa.passkey.register", targetType: "account", targetId: user.id, targetLabel: user.email });
  }
  return NextResponse.json({ verified });
}
