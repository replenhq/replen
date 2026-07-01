"use server";

// Queue page actions — the webapp's half of click-to-queue. Items added here
// (or from brief/alert emails, or from a session) surface in the right repo's
// next coding session, where the agent does the work.

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireWritableUser } from "@/lib/auth/demo-mode";
import { revalidatePath } from "next/cache";

export async function addQueueItem(formData: FormData): Promise<void> {
  const user = await requireWritableUser();
  const title = String(formData.get("title") ?? "").trim().slice(0, 140);
  const project = String(formData.get("project") ?? "").trim().slice(0, 120) || null;
  if (!title) return;
  await db.insert(schema.queuedActions).values({
    userId: user.id, kind: "custom", refId: null, title,
    note: "queued from the webapp", projectSlug: project,
    status: "queued", createdAt: new Date(),
  });
  revalidatePath("/queue");
}

export async function resolveQueueItem(formData: FormData): Promise<void> {
  const user = await requireWritableUser();
  const id = parseInt(String(formData.get("id") ?? ""), 10);
  const outcome = String(formData.get("outcome") ?? "") === "done" ? "done" : "dismissed";
  if (!Number.isFinite(id)) return;
  const row = await db.select({ id: schema.queuedActions.id }).from(schema.queuedActions)
    .where(and(eq(schema.queuedActions.id, id), eq(schema.queuedActions.userId, user.id))).get();
  if (!row) return;
  await db.update(schema.queuedActions)
    .set({ status: outcome, resolvedAt: new Date() })
    .where(eq(schema.queuedActions.id, id));
  revalidatePath("/queue");
}
