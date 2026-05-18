import { NextRequest, NextResponse } from "next/server";
import { setAuthCookies } from "next-firebase-auth-edge/lib/next/cookies";
import { getFirebaseAuth } from "next-firebase-auth-edge/lib/auth";
import { authConfig } from "@/lib/auth/config";

export async function GET(request: NextRequest) {
  try {
    // Audit L11: verify the Firebase ID token's signature BEFORE checking
    // any claims on it. The previous flow decoded the payload without
    // verifying, which let a forged token with email_verified=true probe
    // response codes ("which addresses are allowed through?") even though
    // setAuthCookies would later reject it. Now: bad signature → 401
    // before email is ever read.
    const authz = request.headers.get("authorization") ?? "";
    const m = /^bearer\s+(.+)$/i.exec(authz);
    if (!m) {
      return NextResponse.json({ error: "Sign-in failed: no token." }, { status: 401 });
    }
    const idToken = m[1];
    const { verifyIdToken } = getFirebaseAuth({
      serviceAccount: authConfig.serviceAccount,
      apiKey: authConfig.apiKey,
    });
    let decoded;
    try {
      decoded = await verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: "Sign-in failed: invalid token." }, { status: 401 });
    }
    const email = (decoded.email ?? "").toLowerCase().trim();
    const emailVerified = Boolean(decoded.email_verified);
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
