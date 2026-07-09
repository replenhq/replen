import { db, schema } from "@/db/client";
import { desc } from "drizzle-orm";

// Admin audit trail — append-only record of every admin mutation (role/status
// changes, shared-LLM toggles, invites, source approvals, account deletes).
// Admin actions are role-gated and cross-user by design, so they sit outside
// the tenant-isolation model; this trail is how those privileged writes stay
// accountable. See docs/admin-panel-scope.md §Security posture.

export type AdminAuditInput = {
  actorId: number;
  actorEmail: string;
  action: string;
  targetType?: "user" | "source" | "account" | null;
  targetId?: number | null;
  targetLabel?: string | null;
  meta?: Record<string, unknown> | null;
};

// Record one admin action. Non-fatal by design: the mutation it describes has
// already committed, so a logging failure must never surface as a failed admin
// action. Errors are logged, not thrown.
export async function recordAdminAction(input: AdminAuditInput): Promise<void> {
  try {
    await db.insert(schema.adminAudit).values({
      actorUserId: input.actorId,
      actorEmail: input.actorEmail,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      meta: input.meta ? JSON.stringify(input.meta) : null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error(`[admin audit] failed to record ${input.action}`, e);
  }
}

export type AdminAuditRow = typeof schema.adminAudit.$inferSelect;

export async function recentAdminActions(limit = 200): Promise<AdminAuditRow[]> {
  return db.select().from(schema.adminAudit).orderBy(desc(schema.adminAudit.createdAt)).limit(limit);
}
