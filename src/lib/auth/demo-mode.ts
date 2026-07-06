// Demo-account infrastructure.
//
// There is no longer a live web demo surface (the old /demo routes were
// removed — the product is demonstrated with GIFs/videos, since an MCP +
// skill flow can't be shown as a seeded dashboard). What remains here is the
// read-only *account* guard: a seeded demo/test account (email
// DEMO_USER_EMAIL) is still recognised so it can never mint writes, and
// test-cohort.ts uses the same identity to exclude seed accounts from
// cross-user aggregates.

import { requireUser } from "./current-user";

export const DEMO_USER_EMAIL = (process.env.DEMO_USER_EMAIL ?? "demo@replen.dev").toLowerCase();

export function isDemoUser(user: { email: string }): boolean {
  return user.email.toLowerCase() === DEMO_USER_EMAIL;
}

// Used by every server action that mutates state. Returns the active user when
// they're a normal account, throws for the seeded demo account. Defence-in-depth
// so a demo/test account can never trigger a real write.
export async function requireWritableUser() {
  const user = await requireUser();
  if (isDemoUser(user)) {
    throw new Error("This is the read-only demo account. Sign up at /login to use Replen on your own repos.");
  }
  return user;
}
