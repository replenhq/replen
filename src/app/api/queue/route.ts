import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { authenticate, corsHeaders } from "../mcp/_auth";

// Queue management for the in-session agent (the replen_queue MCP tool).
//
//   { action: "list" }                                  → pending items
//   { action: "add", title, note?, project?, kind? }    → queue something
//   { action: "done" | "dismiss", id }                  → resolve an item
//
// 'done' means the agent handled it; 'dismiss' means the user decided to
// drop it. Both stop the session reminders.

type Body = {
  action?: string;
  id?: number;
  title?: string;
  note?: string;
  project?: string;
  kind?: string;
};

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  if (body.action === "list") {
    const items = await db.select().from(schema.queuedActions)
      .where(and(eq(schema.queuedActions.userId, auth.userId), eq(schema.queuedActions.status, "queued")))
      .orderBy(schema.queuedActions.createdAt);
    return NextResponse.json({
      items: items.map((i) => ({
        id: i.id, kind: i.kind, title: i.title, note: i.note,
        project: i.projectSlug, queuedAt: i.createdAt.toISOString(),
      })),
    }, { headers: corsHeaders });
  }

  if (body.action === "add") {
    const title = body.title?.trim().slice(0, 140);
    if (!title) return NextResponse.json({ error: "title required" }, { status: 400, headers: corsHeaders });
    const inserted = await db.insert(schema.queuedActions).values({
      userId: auth.userId,
      kind: body.kind?.trim().slice(0, 40) || "custom",
      refId: null,
      title,
      note: body.note?.slice(0, 1000) ?? null,
      projectSlug: body.project?.slice(0, 120) ?? null,
      status: "queued",
      createdAt: new Date(),
    }).returning({ id: schema.queuedActions.id }).get();
    return NextResponse.json({ ok: true, id: inserted?.id }, { headers: corsHeaders });
  }

  if (body.action === "done" || body.action === "dismiss") {
    if (typeof body.id !== "number") return NextResponse.json({ error: "id required" }, { status: 400, headers: corsHeaders });
    const row = await db.select({ id: schema.queuedActions.id }).from(schema.queuedActions)
      .where(and(eq(schema.queuedActions.id, body.id), eq(schema.queuedActions.userId, auth.userId))).get();
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404, headers: corsHeaders });
    await db.update(schema.queuedActions)
      .set({ status: body.action === "done" ? "done" : "dismissed", resolvedAt: new Date() })
      .where(eq(schema.queuedActions.id, body.id));
    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  }

  return NextResponse.json({ error: "action must be list | add | done | dismiss" }, { status: 400, headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
