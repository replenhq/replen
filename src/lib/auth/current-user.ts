import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTokens } from "next-firebase-auth-edge/lib/next/tokens";
import { authConfig } from "./config";
import { db, schema } from "@/db/client";
import { eq, gte, isNull } from "drizzle-orm";

export type CurrentUser = {
  id: number;
  firebaseUid: string;
  email: string;
  displayName: string | null;
  role: "admin" | "user";
  status: "active" | "pending" | "suspended";
};

/**
 * Reads the Firebase session cookie, validates it, finds or creates a row in
 * users keyed by firebase_uid. Returns null if no valid session.
 *
 * Admin is gated by the BOOTSTRAP_ADMIN_EMAIL env var. Only the user whose
 * Firebase email matches that value becomes admin on first sign-in; all
 * other first-sign-ins land as plain `user`. This closes the
 * first-user-becomes-admin race that existed when admin was inferred from
 * "no admin exists yet" alone.
 *
 * Invited users (a pre-existing row with firebase_uid: "invited:<email>") get
 * upgraded to their real uid on first sign-in. We refuse the upgrade until
 * Firebase reports email_verified=true: otherwise an attacker who can prove
 * possession of any address resembling an invited one (unverified provider,
 * spoofed display name) could claim that account.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const tokens = await getTokens(cookieStore, authConfig);
  if (!tokens) return null;

  const uid = tokens.decodedToken.uid;
  // Audit L10: lowercase the email before any lookup. The admin invite path
  // inserts emails lowercased, but Firebase preserves the case the user
  // signed up with. Without normalisation, Alice@example.com signing up to
  // claim an invite for alice@example.com would miss and land as a fresh
  // pending row.
  const email = ((tokens.decodedToken.email as string) ?? "").trim().toLowerCase();
  // GitHub OAuth doesn't set Firebase's email_verified claim, even though
  // GitHub itself only exposes verified primary emails via OAuth. Treat
  // any GitHub- or Google-sourced sign-in as email-verified — equivalent
  // trust to what Google's OAuth claims us.
  //
  // The next-firebase-auth-edge session cookie sets `sign_in_provider` to
  // "custom" because it re-issues the token as a session. But it preserves
  // the original provider in `source_sign_in_provider` AND keeps the
  // `firebase.identities` map intact. Check both for robustness.
  // Email-magic-link continues to flip email_verified=true on first
  // successful click, so that path is already covered by the raw claim.
  const dt = tokens.decodedToken as {
    email_verified?: boolean;
    source_sign_in_provider?: string;
    firebase?: { sign_in_provider?: string; identities?: Record<string, unknown> };
  };
  const identities = dt.firebase?.identities ?? {};
  const sourceProvider = dt.source_sign_in_provider ?? "";
  const provider = dt.firebase?.sign_in_provider ?? "";
  const isOAuthVerified =
    "github.com" in identities ||
    "google.com" in identities ||
    sourceProvider === "github.com" ||
    sourceProvider === "google.com" ||
    provider === "github.com" ||
    provider === "google.com";
  const emailVerified = Boolean(dt.email_verified) || isOAuthVerified;
  const displayName = (tokens.decodedToken.name as string) ?? null;

  let row = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.firebaseUid, uid))
    .get();

  if (!row && email) {
    // Admin may have pre-invited this person. Only bind the firebase_uid once
    // Firebase has confirmed the email is verified - otherwise unverified
    // sign-ups could claim arbitrary invited rows.
    const invited = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    if (invited && invited.firebaseUid.startsWith("invited:")) {
      if (!emailVerified) {
        console.warn(`[auth] refusing to bind invited row for ${email}: email not yet verified by Firebase`);
        return null;
      }
      await db.update(schema.users).set({ firebaseUid: uid, displayName, lastLoginAt: new Date() }).where(eq(schema.users.id, invited.id));
      row = { ...invited, firebaseUid: uid, displayName, lastLoginAt: new Date() } as typeof invited;
    }
  }

  if (!row) {
    // First-time sign-in. Two paths:
    //   (a) Bootstrap admin: the verified email matches BOOTSTRAP_ADMIN_EMAIL,
    //       so this is the operator's own first sign-in. Created as active
    //       admin and given the legacy NULL-userId backfill.
    //   (b) Public self-serve sign-up: anyone else with a verified email.
    //       Created with status='active' so they land on /welcome and walk
    //       the onboarding wizard themselves. Admin moderation moves from
    //       gating-by-default to suspending-when-needed (via /admin).
    //
    // Email must be verified for path (b). OAuth providers (Google /
    // GitHub) auto-verify; email magic-link sign-in flips the bit on
    // first successful click. Unverified emails are refused — defence
    // against scripted signups against scratch addresses.
    //
    // Rate limit (defensive): cap new sign-ups per 24h via env
    // REPLEN_DAILY_SIGNUP_CAP (default 50). Returning null surfaces a
    // generic auth failure to the client; admin can raise the cap if
    // a legit traffic burst hits it.
    //
    // Race: two parallel requests for a brand-new uid both miss the
    // SELECT above and both attempt an INSERT. The second one would hit
    // the uniq_user_firebase_uid / uniq_user_email constraint and
    // surface a 500 to the user. onConflictDoNothing + re-select
    // converts that collision into a benign no-op.
    const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").replace(/\s+/g, "").toLowerCase();
    let matchesBootstrap = !!bootstrapEmail && email === bootstrapEmail && emailVerified;
    if (matchesBootstrap) {
      // Audit L10: refuse bootstrap-admin if an admin already exists.
      // The existing flow let a swapped BOOTSTRAP_ADMIN_EMAIL mid-deploy
      // create a second admin on first sign-in, granting canUseSharedLlm
      // + role bypass without any in-app step. With a real admin already
      // present we degrade to a normal active user.
      const existingAdmin = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.role, "admin"))
        .get();
      if (existingAdmin) {
        console.warn(`[auth] BOOTSTRAP_ADMIN_EMAIL matched ${email} but an admin already exists; creating as normal active user`);
        matchesBootstrap = false;
      }
    }
    if (!matchesBootstrap) {
      if (!emailVerified) {
        console.warn(`[auth] refusing self-serve signup for ${email}: email not yet verified`);
        return null;
      }
      const cap = parseInt(process.env.REPLEN_DAILY_SIGNUP_CAP ?? "50", 10);
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(gte(schema.users.createdAt, oneDayAgo));
      if (recent.length >= cap) {
        console.warn(`[auth] daily signup cap (${cap}) hit; refusing ${email}`);
        return null;
      }
    }
    await db
      .insert(schema.users)
      .values({
        firebaseUid: uid,
        email,
        displayName,
        role: matchesBootstrap ? "admin" : "user",
        status: "active",
        canUseSharedLlm: matchesBootstrap,
        createdAt: new Date(),
        lastLoginAt: new Date(),
      })
      .onConflictDoNothing();
    row = await db.select().from(schema.users).where(eq(schema.users.firebaseUid, uid)).get();
    if (!row) {
      // The conflict landed on uniq_user_email rather than uniq_user_firebase_uid
      // (would happen if the same email signed up with a different uid). Look
      // up by email and refuse to rebind without manual admin action — closes
      // a silent account-takeover path.
      const byEmail = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
      if (byEmail) {
        console.warn(`[auth] sign-in for ${email} with uid ${uid} conflicts with existing row (uid=${byEmail.firebaseUid}); refusing to rebind`);
      }
      return null;
    }
    if (matchesBootstrap) {
      // One-time backfill: rows with NULL user_id (pre-phase-2) belong to this admin.
      // Idempotent — running it twice is a no-op because the second pass has no
      // NULL rows left.
      await db.update(schema.candidates).set({ userId: row.id }).where(isNull(schema.candidates.userId));
      await db.update(schema.projectProfiles).set({ userId: row.id }).where(isNull(schema.projectProfiles.userId));
      await db.update(schema.matches).set({ userId: row.id }).where(isNull(schema.matches.userId));
      await db.update(schema.digestRuns).set({ userId: row.id }).where(isNull(schema.digestRuns.userId));
    } else {
      console.log(`[auth] new active account created for ${email} (self-serve signup)`);
    }
  } else {
    await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, row.id));
  }

  // 'suspended' is a hard block: refuse to resolve. 'pending' (legacy —
  // no new sign-ups create pending rows since self-serve flipped on)
  // still routes via /pending if any legacy rows exist. The layout +
  // page-level guards downstream restrict what they can see.
  if (row.status === "suspended") return null;
  return {
    id: row.id,
    firebaseUid: row.firebaseUid,
    email: row.email,
    displayName: row.displayName,
    role: row.role as "admin" | "user",
    status: row.status as "active" | "pending" | "suspended",
  };
}

/**
 * For routes/actions that require a logged-in user.
 * Throws if not authenticated - pair with Next's error boundary or call from
 * a server component after the middleware has gated the path.
 *
 * Pending users (newly-signed-up, not yet approved by an admin) are redirected
 * to /pending. Server actions and API routes that don't want the redirect
 * can call getCurrentUser() directly and gate on `status === "active"`.
 */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new Error("unauthenticated");
  if (u.status === "pending") redirect("/pending");
  return u;
}

// Typed sentinel so top-level error boundaries can render 403 instead of a
// generic 500. Use `instanceof ForbiddenError` to discriminate.
export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== "admin") throw new ForbiddenError("admin role required");
  return u;
}
