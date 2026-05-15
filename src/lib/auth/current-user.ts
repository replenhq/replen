import { cookies } from "next/headers";
import { getTokens } from "next-firebase-auth-edge/lib/next/tokens";
import { authConfig } from "./config";
import { db, schema } from "@/db/client";
import { and, eq, isNull } from "drizzle-orm";

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
 * The first user to ever sign in becomes admin automatically.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const tokens = await getTokens(await cookies(), authConfig);
  if (!tokens) return null;

  const uid = tokens.decodedToken.uid;
  const email = (tokens.decodedToken.email as string) ?? "";
  const displayName = (tokens.decodedToken.name as string) ?? null;

  let row = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.firebaseUid, uid))
    .get();

  if (!row && email) {
    // Admin may have pre-invited this person — bind the firebase_uid now.
    const invited = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    if (invited && invited.firebaseUid.startsWith("invited:")) {
      await db.update(schema.users).set({ firebaseUid: uid, displayName, lastLoginAt: new Date() }).where(eq(schema.users.id, invited.id));
      row = { ...invited, firebaseUid: uid, displayName, lastLoginAt: new Date() } as typeof invited;
    }
  }

  if (!row) {
    // First-time user. If no admin exists yet, become admin AND claim
    // all pre-existing single-tenant data (any rows with NULL user_id).
    const adminExists = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "admin")).get();
    const becomeAdmin = !adminExists;
    const inserted = await db
      .insert(schema.users)
      .values({
        firebaseUid: uid,
        email,
        displayName,
        role: becomeAdmin ? "admin" : "user",
        status: "active",
        canUseSharedLlm: becomeAdmin, // admin auto-uses shared keys; users must be granted
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
 * Throws if not authenticated — pair with Next's error boundary or call from
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

void and;
