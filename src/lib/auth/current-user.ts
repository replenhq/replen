import { cookies } from "next/headers";
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
  status: "active" | "suspended";
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
    // First-time user. Admin role is granted *only* if BOOTSTRAP_ADMIN_EMAIL
    // matches the verified email of this signup. Without the env var set,
    // no admin is ever auto-created on signup (operator must run a
    // privileged CLI / direct DB update). This closes the race where two
    // concurrent first-sign-ins could both observe "no admin exists" and
    // both insert as admin.
    const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
    const becomeAdmin = !!bootstrapEmail && email.toLowerCase() === bootstrapEmail && emailVerified;
    const inserted = await db
      .insert(schema.users)
      .values({
        firebaseUid: uid,
        email,
        displayName,
        role: becomeAdmin ? "admin" : "user",
        status: "active",
        canUseSharedLlm: becomeAdmin,
        createdAt: new Date(),
        lastLoginAt: new Date(),
      })
      .returning()
      .get();
    row = inserted!;
    if (becomeAdmin) {
      // One-time backfill: rows with NULL user_id (pre-phase-2) belong to this admin.
      await db.update(schema.candidates).set({ userId: row.id }).where(isNull(schema.candidates.userId));
      await db.update(schema.projectProfiles).set({ userId: row.id }).where(isNull(schema.projectProfiles.userId));
      await db.update(schema.matches).set({ userId: row.id }).where(isNull(schema.matches.userId));
      await db.update(schema.digestRuns).set({ userId: row.id }).where(isNull(schema.digestRuns.userId));
    }
  } else {
    await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, row.id));
  }

  if (row.status !== "active") return null;
  return {
    id: row.id,
    firebaseUid: row.firebaseUid,
    email: row.email,
    displayName: row.displayName,
    role: row.role as "admin" | "user",
    status: row.status as "active" | "suspended",
  };
}

/**
 * For routes/actions that require a logged-in user.
 * Throws if not authenticated - pair with Next's error boundary or call from
 * a server component after the middleware has gated the path.
 */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new Error("unauthenticated");
  return u;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== "admin") throw new Error("forbidden");
  return u;
}
