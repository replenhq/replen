import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireAdmin } from "@/lib/auth/current-user";
import { admin2faSigningKey } from "@/lib/crypto";

// Admin 2FA gate. A SECOND factor layered on top of the Firebase session, on
// /admin only, for admins only. Two enrolled factors (WebAuthn passkey =
// primary, TOTP = fallback); passing EITHER mints a short-lived signed session
// cookie so the admin re-verifies at most once per SESSION_TTL. Cookies are
// HMAC-signed with a key derived from ENCRYPTION_KEY (see admin2faSigningKey).

const CHALLENGE_COOKIE = "replen_admin_challenge"; // holds a WebAuthn ceremony challenge
const SESSION_COOKIE = "replen_admin_2fa"; // "passed 2FA this session"
const CHALLENGE_TTL_S = 5 * 60;
const SESSION_TTL_S = 12 * 60 * 60;
const isProd = process.env.NODE_ENV === "production";

// ── signed token (payload.hmac, base64url) ──
function sign(payloadB64: string): string {
  return createHmac("sha256", admin2faSigningKey()).update(payloadB64).digest("base64url");
}
function makeToken(payload: Record<string, unknown>): string {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${p}.${sign(p)}`;
}
function readToken(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const p = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(p);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── relying-party config (ported from British-Housing's getRpConfig) ──
// WebAuthn binds a credential to the rpID (the domain). ADMIN_RP_ID pins it in
// prod (set it to app.replen.dev); otherwise it derives from the forwarded
// host so localhost dev works. Origin is https://<rpID> in prod, http://<host>
// on localhost.
export async function getRpConfig(): Promise<{ rpID: string; rpName: string; origin: string }> {
  const h = await headers();
  const rawHost = (h.get("x-forwarded-host") ?? h.get("host") ?? "").trim();
  const hostnameOnly = (rawHost.split(":")[0] || "localhost").toLowerCase();
  const rpID = process.env.ADMIN_RP_ID?.trim() || hostnameOnly;
  const isLocalhost = rpID === "localhost" || rpID === "127.0.0.1";
  const origin = isLocalhost ? `http://${rawHost || "localhost:3000"}` : `https://${rpID}`;
  return { rpID, rpName: "Replen Admin", origin };
}

export type Ceremony = "register" | "authenticate";

export async function setChallengeCookie(challenge: string, ceremony: Ceremony): Promise<void> {
  const token = makeToken({ challenge, ceremony, exp: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_S });
  const jar = await cookies();
  jar.set(CHALLENGE_COOKIE, token, { httpOnly: true, secure: isProd, sameSite: "strict", maxAge: CHALLENGE_TTL_S, path: "/" });
}

export async function readAndClearChallenge(ceremony: Ceremony): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(CHALLENGE_COOKIE)?.value;
  jar.delete(CHALLENGE_COOKIE);
  const payload = readToken(token);
  if (!payload || payload.ceremony !== ceremony) return null;
  return typeof payload.challenge === "string" ? payload.challenge : null;
}

// ── 2FA session ("passed this session") ──
export async function mintAdmin2fa(userId: number): Promise<void> {
  const token = makeToken({ uid: userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { httpOnly: true, secure: isProd, sameSite: "lax", maxAge: SESSION_TTL_S, path: "/" });
}

export async function admin2faVerified(userId: number): Promise<boolean> {
  const jar = await cookies();
  const payload = readToken(jar.get(SESSION_COOKIE)?.value);
  return !!payload && payload.uid === userId;
}

export async function clearAdmin2fa(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

// Has the admin set up at least one usable factor? (a CONFIRMED TOTP secret, or
// any registered passkey). Gates enroll-vs-challenge routing.
export async function hasEnrolledFactor(userId: number): Promise<boolean> {
  const totp = await db
    .select({ userId: schema.adminTotp.userId })
    .from(schema.adminTotp)
    .where(and(eq(schema.adminTotp.userId, userId), isNotNull(schema.adminTotp.confirmedAt)))
    .get();
  if (totp) return true;
  const pk = await db.select({ id: schema.adminPasskeys.id }).from(schema.adminPasskeys).where(eq(schema.adminPasskeys.userId, userId)).get();
  return !!pk;
}

// The gate for protected admin content pages. requireAdmin() first (auth +
// role), then the 2FA session check. Not verified -> redirect to the challenge
// (if a factor is enrolled) or to enrollment (if not). The /admin/verify and
// /admin/security pages call requireAdmin() ONLY, never this, so they stay
// reachable.
export async function requireAdmin2fa() {
  const admin = await requireAdmin();
  if (await admin2faVerified(admin.id)) return admin;
  const enrolled = await hasEnrolledFactor(admin.id);
  redirect(enrolled ? "/admin/verify" : "/admin/security");
}
