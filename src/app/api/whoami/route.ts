import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json({ user });
  } catch (e: any) {
    console.error("[/api/whoami]", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
