import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { authenticationOptions } from "@/lib/admin/webauthn";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { options, hasPasskeys } = await authenticationOptions(user.id);
  return NextResponse.json({ options, hasPasskeys });
}
