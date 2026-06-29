import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { verifyQueueParams } from "@/lib/queue-sign";
import { escapeHtml } from "@/email/escape";

// Click-to-queue from email. The link's HMAC signature (see
// src/lib/queue-sign.ts) is the authorisation — no session needed, and the
// signature only permits inserting this exact item for this exact user.
// Idempotent: re-clicking a link lands on the same queued row.

function parse(req: Request): { userId: number; kind: string; refId: number | null; title: string; sig: string } {
  const url = new URL(req.url);
  const refRaw = url.searchParams.get("r") ?? "";
  return {
    userId: parseInt(url.searchParams.get("u") ?? "", 10),
    kind: url.searchParams.get("k") ?? "",
    refId: refRaw === "" ? null : parseInt(refRaw, 10),
    title: (url.searchParams.get("t") ?? "").slice(0, 140),
    sig: url.searchParams.get("sig") ?? "",
  };
}
function validSig(p: ReturnType<typeof parse>): boolean {
  try {
    return Number.isFinite(p.userId) && !!p.kind && !!p.title && !!p.sig && verifyQueueParams(p.userId, p.kind, p.refId, p.title, p.sig);
  } catch { return false; }
}
const badLink = () => new NextResponse(page("That link didn't verify.", "It may have been truncated by your mail client."), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });

// GET = a confirmation page only; it does NOT write. Mail-client link scanners
// (Outlook SafeLinks, Proofpoint) and unfurlers auto-fetch URLs in email, which
// would otherwise silently queue the item. The insert happens only on the POST.
export async function GET(req: Request) {
  const p = parse(req);
  if (!validSig(p)) return badLink();
  const form =
    `<form method="post" style="margin-top:8px">` +
    `<button type="submit" style="font:inherit;font-weight:600;background:#1f3a8a;color:#fff;border:0;border-radius:8px;padding:11px 20px;cursor:pointer">Queue this for my next session</button>` +
    `</form>`;
  return new NextResponse(
    page("Queue this?", `Click below to queue “${escapeHtml(p.title)}”. Your agent will offer to handle it at the start of your next coding session.${form}`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// POST = apply (from the confirm button).
export async function POST(req: Request) {
  const p = parse(req);
  if (!validSig(p)) return badLink();

  // Defence in depth: only an active user gets a queue write (a suspended
  // account shouldn't keep accepting items via old email links).
  const u = await db.select({ status: schema.users.status }).from(schema.users)
    .where(eq(schema.users.id, p.userId)).get();
  if (!u || u.status !== "active") {
    return new NextResponse(page("That link didn't verify.", "This account isn't active."), {
      status: 403, headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const existing = await db.select({ id: schema.queuedActions.id }).from(schema.queuedActions)
    .where(and(
      eq(schema.queuedActions.userId, p.userId),
      eq(schema.queuedActions.kind, p.kind),
      p.refId != null ? eq(schema.queuedActions.refId, p.refId) : sql`${schema.queuedActions.title} = ${p.title}`,
      eq(schema.queuedActions.status, "queued"),
    )).get();
  if (!existing) {
    await db.insert(schema.queuedActions).values({
      userId: p.userId, kind: p.kind, refId: p.refId, title: p.title, status: "queued", createdAt: new Date(),
    });
  }

  return new NextResponse(
    page("Queued", `“${escapeHtml(p.title)}” will come up at the start of your next coding session. Your agent will offer to handle it.`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function page(h: string, p: string): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1a1a1a">
<h2>${h}</h2><p style="color:#555">${p}</p>
<p style="color:#999;font-size:13px">Replen. Calm awareness for your stack.</p></body>`;
}
