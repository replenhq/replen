import { db, schema } from "../db/client";
import { and, eq, isNull, lt } from "drizzle-orm";

// Cron-side aging: soft-archive hidden matches older than `days` for every
// active user. Soft because we want recoverability - the dashboard filters
// out archived rows but they stay in the DB. Run nightly via the scheduler.
//
// Symmetric with the per-user `archiveOldHidden` server action on /settings.
export async function archiveOldHiddenForAllUsers(days: number = 90): Promise<{ archived: number; users: number }> {
  const cutoff = new Date(Date.now() - days * 86400_000);
  const users = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.status, "active"));
  let total = 0;
  for (const u of users) {
    const res = await db
      .update(schema.matches)
      .set({ archivedAt: new Date() })
      .where(and(
        eq(schema.matches.userId, u.id),
        eq(schema.matches.userStatus, "hidden"),
        lt(schema.matches.createdAt, cutoff),
        isNull(schema.matches.archivedAt),
      ));
    total += (res as { changes?: number }).changes ?? 0;
  }
  return { archived: total, users: users.length };
}
