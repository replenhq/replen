// Demo mode infrastructure.
//
// /demo/* are real, public Next.js routes — each demo page renders the
// seeded demo user's data directly. No cookie, no auth bypass, no
// middleware rewrite. The demo user is created by scripts/seed-demo.ts
// with email DEMO_USER_EMAIL (default "demo@replen.dev").

import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { CurrentUser } from "./current-user";

export const DEMO_USER_EMAIL = (process.env.DEMO_USER_EMAIL ?? "demo@replen.dev").toLowerCase();

export function isDemoUser(user: { email: string }): boolean {
  return user.email.toLowerCase() === DEMO_USER_EMAIL;
}

// Resolves the seeded demo user from the DB. Used by every /demo/*
// page in place of requireUser(). Calls notFound() (→ 404) if the
// seed user is missing instead of throwing — a missing demo user is
// an ops gap, not a user-facing error.
export async function getDemoUser(): Promise<CurrentUser> {
  const row = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, DEMO_USER_EMAIL))
    .get();
  if (!row) notFound();
  return {
    id: row.id,
    firebaseUid: row.firebaseUid,
    email: row.email,
    displayName: row.displayName ?? null,
    role: row.role as "admin" | "user",
    status: row.status as "active" | "pending" | "suspended",
  };
}

// Used by every server action that mutates state. Returns the active
// user when they're a normal account, throws when called from a demo
// context. Defence-in-depth: /demo pages render visual-only components,
// so this guard shouldn't normally fire, but it catches any path that
// would otherwise let a demo render trigger a real write.
import { requireUser } from "./current-user";

export async function requireWritableUser() {
  const user = await requireUser();
  if (isDemoUser(user)) {
    throw new Error("This is the read-only demo. Sign up at /login to use it on your own repos.");
  }
  return user;
}
