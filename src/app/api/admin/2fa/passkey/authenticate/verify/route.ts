import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { verifyAuthentication } from "@/lib/admin/webauthn";
import { mintAdmin2fa } from "@/lib/admin/2fa";
import { recordAdminAction } from "@/lib/admin/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (!body?.response) return NextResponse.json({ error: "missing response" }, { status: 400 });
  const verified = await verifyAuthentication(user.id, body.response);
  if (verified) {
    await mintAdmin2fa(user.id);
    await recordAdminAction({ actorId: user.id, actorEmail: user.email, action: "admin.2fa.pass", targetType: "account", targetId: user.id, targetLabel: `${user.email} (passkey)` });
  }
  return NextResponse.json({ verified });
}
