import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { verifyQueueParams } from "@/lib/queue-sign";
import { escapeHtml } from "@/email/escape";

// Click-to-queue from email. The link's HMAC signature (see
// src/lib/queue-sign.ts) is the authorisation — no session needed, and the
// signature only permits inserting this exact item for this exact user.
// Idempotent: re-clicking a link lands on the same queued row.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = parseInt(url.searchParams.get("u") ?? "", 10);
  const kind = url.searchParams.get("k") ?? "";
  const refRaw = url.searchParams.get("r") ?? "";
  const refId = refRaw === "" ? null : parseInt(refRaw, 10);
  const title = (url.searchParams.get("t") ?? "").slice(0, 140);
  const sig = url.searchParams.get("sig") ?? "";

  const ok = Number.isFinite(userId) && kind && title && sig;
  let valid = false;
  try {
    valid = !!ok && verifyQueueParams(userId, kind, refId, title, sig); // constant-time
  } catch {
    valid = false;
  }
  if (!valid) {
    return new NextResponse(page("That link didn't verify.", "It may have been truncated by your mail client."), {
      status: 400, headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Defence in depth: only an active user gets a queue write (a suspended
  // account shouldn't keep accepting items via old email links).
  const u = await db.select({ status: schema.users.status }).from(schema.users)
    .where(eq(schema.users.id, userId)).get();
  if (!u || u.status !== "active") {
    return new NextResponse(page("That link didn't verify.", "This account isn't active."), {
      status: 403, headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const existing = await db.select({ id: schema.queuedActions.id }).from(schema.queuedActions)
    .where(and(
      eq(schema.queuedActions.userId, userId),
      eq(schema.queuedActions.kind, kind),
      refId != null ? eq(schema.queuedActions.refId, refId) : sql`${schema.queuedActions.title} = ${title}`,
      eq(schema.queuedActions.status, "queued"),
    )).get();
  if (!existing) {
    await db.insert(schema.queuedActions).values({
      userId, kind, refId, title, status: "queued", createdAt: new Date(),
    });
  }

  return new NextResponse(
    page("Queued ✓", `“${escapeHtml(title)}” will come up at the start of your next coding session — your agent will offer to handle it.`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function page(h: string, p: string): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1a1a1a">
<h2>${h}</h2><p style="color:#555">${p}</p>
<p style="color:#999;font-size:13px">Replen — calm awareness for your stack.</p></body>`;
}
