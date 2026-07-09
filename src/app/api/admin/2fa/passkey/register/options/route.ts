import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { registrationOptions } from "@/lib/admin/webauthn";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const options = await registrationOptions(user.id, user.email);
  return NextResponse.json(options);
}
