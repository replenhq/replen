import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";

// Public diagnostic. Only return what the dashboard UI actually needs;
// withholding firebaseUid + local users.id closes the IDOR-probe vector
// where an attacker via XSS or a curious user could fingerprint the
// numeric tenant id or Firebase identity.
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ user: null });
    return NextResponse.json({
      user: {
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
      },
    });
  } catch (e) {
    console.error("[/api/whoami]", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
