import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTokens } from "next-firebase-auth-edge/lib/next/tokens";
import { authConfig } from "./config";
import { db, schema } from "@/db/client";
import { eq, isNull } from "drizzle-orm";

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
  const tokens = await getTokens(await cookies(), authConfig);
  if (!tokens) return null;

  const uid = tokens.decodedToken.uid;
  const email = (tokens.decodedToken.email as string) ?? "";
  const emailVerified = Boolean((tokens.decodedToken as { email_verified?: boolean }).email_verified);
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
    //   (b) Public sign-up: anyone else with a verified email. Created with
    //       status='pending'. The scheduler / dashboard / API routes all
    //       gate on status='active', so a pending user can authenticate but
    //       can't run pipelines, consume any scheduler slot, or see anyone
    //       else's data. They land on /pending until an admin approves them
    //       from /admin.
    //
    // Race: two parallel requests for a brand-new uid both miss the SELECT
    // above and both attempt an INSERT. The second one would hit the
    // uniq_user_firebase_uid / uniq_user_email constraint and surface a
    // 500 to the user. onConflictDoNothing + re-select converts that
    // collision into a benign no-op.
    const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").replace(/\s+/g, "").toLowerCase();
    const matchesBootstrap = !!bootstrapEmail && email.toLowerCase() === bootstrapEmail && emailVerified;
    await db
      .insert(schema.users)
      .values({
        firebaseUid: uid,
        email,
        displayName,
        role: matchesBootstrap ? "admin" : "user",
        status: matchesBootstrap ? "active" : "pending",
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
      console.log(`[auth] new pending account created for ${email} (awaiting admin approval)`);
    }
  } else {
    await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, row.id));
  }

  // 'suspended' is a hard block: refuse to resolve. 'pending' is allowed
  // through so we can render the /pending holding page, but the layout +
  // page-level guards downstream restrict what they can actually see.
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
