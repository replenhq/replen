import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";

// Public diagnostic. Only return what the dashboard UI actually needs;
// withholding firebaseUid + local users.id + role closes the IDOR-probe
// vector where someone holding any session cookie could fingerprint
// who is admin / who is suspended.
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ user: null });
    return NextResponse.json({
      user: {
        email: user.email,
        displayName: user.displayName,
        status: user.status,
      },
    });
  } catch (e) {
    console.error("[/api/whoami]", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
