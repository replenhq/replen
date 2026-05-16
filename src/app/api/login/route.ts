import { NextRequest, NextResponse } from "next/server";
import { setAuthCookies } from "next-firebase-auth-edge/lib/next/cookies";
import { authConfig } from "@/lib/auth/config";

// Decode (without verifying) the email + email_verified claims from a Firebase
// ID token. Verification happens inside setAuthCookies; we just need the email
// to run the allowlist check before establishing a session.
function decodeJwtPayload(authzHeader: string): { email?: string; email_verified?: boolean } | null {
  const m = /^bearer\s+(.+)$/i.exec(authzHeader);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    // Soft gate: require email_verified=true on the Firebase token before we
    // hand out a session cookie. Verified email is the bare-minimum proof of
    // address ownership; without it, a malicious user could enrol with an
    // unverified provider and claim someone else's address.
    //
    // We deliberately don't enforce an invite-list here: new sign-ins are
    // allowed through, but the row is created with status='pending' inside
    // getCurrentUser, so they can't do anything until an admin approves them
    // from /admin. The scheduler / API routes / dashboard all gate on
    // status='active'.
    const payload = decodeJwtPayload(request.headers.get("authorization") ?? "");
    const email = (payload?.email ?? "").toLowerCase().trim();
    const emailVerified = Boolean(payload?.email_verified);
    if (!email) {
      return NextResponse.json({ error: "Sign-in failed: no email on token." }, { status: 401 });
    }
    if (!emailVerified) {
      return NextResponse.json({ error: "Please verify your email address with the provider first, then try again." }, { status: 403 });
    }
    return await setAuthCookies(request.headers, { ...authConfig, enableMultipleCookies: true });
  } catch (err) {
    // Log full detail server-side. The response body stays generic — leaking
    // Firebase internals (project id, key id, offending uid) to anyone who
    // can hit this endpoint is unnecessary fingerprinting.
    console.error("Login error:", err);
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 }
    );
  }
}
