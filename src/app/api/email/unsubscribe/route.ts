import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { verifyUnsub } from "@/lib/unsub-sign";

// One-click unsubscribe / per-channel opt-out from email. The link's HMAC
// signature (src/lib/unsub-sign.ts) IS the authorisation — no session needed, and
// it only permits flipping THIS user's THIS channel (a forwarded link can't touch
// anyone else). GET = the footer link (shows a confirmation page); POST = RFC 8058
// List-Unsubscribe-Post one-click, which Gmail/Apple Mail fire automatically.

type Scope = "all" | "brief" | "alerts" | "digest";
const LABEL: Record<Scope, string> = {
  all: "all Replen emails",
  brief: "the weekly brief",
  alerts: "critical security alerts",
  digest: "the matches digest",
};

function parse(req: Request): { userId: number; scope: string; sig: string } {
  const url = new URL(req.url);
  return {
    userId: parseInt(url.searchParams.get("u") ?? "", 10),
    scope: url.searchParams.get("s") ?? "",
    sig: url.searchParams.get("sig") ?? "",
  };
}

function valid(userId: number, scope: string, sig: string): boolean {
  try {
    return Number.isFinite(userId) && !!scope && !!sig && verifyUnsub(userId, scope, sig); // constant-time
  } catch {
    return false;
  }
}

async function apply(userId: number, scope: Scope): Promise<void> {
  const patch =
    scope === "all" ? { enabled: false }
    : scope === "brief" ? { weeklyBriefEnabled: false, briefFrequency: "off" }
    : scope === "alerts" ? { securityAlertsEnabled: false }
    : { digestEnabled: false };
  await db.update(schema.userSettings).set({ ...patch, updatedAt: new Date() }).where(eq(schema.userSettings.userId, userId));
}

// POST = apply. Used by both the RFC 8058 List-Unsubscribe-Post one-click (which
// Gmail/Apple Mail fire automatically) and the confirm button on the GET page.
export async function POST(req: Request) {
  const { userId, scope, sig } = parse(req);
  if (!valid(userId, scope, sig)) return new NextResponse("invalid", { status: 400 });
  await apply(userId, scope as Scope);
  return new NextResponse(
    page("Unsubscribed", `You're off ${LABEL[scope as Scope]}. Change your mind anytime in your <a href="/settings" style="color:#1f3a8a">email preferences</a>.`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// GET = a confirmation page only. It deliberately does NOT mutate: mail-client
// link scanners (Outlook SafeLinks, Proofpoint) and unfurlers auto-fetch URLs in
// email, which would otherwise silently unsubscribe the recipient. The change is
// applied only by the explicit POST below.
export async function GET(req: Request) {
  const { userId, scope, sig } = parse(req);
  if (!valid(userId, scope, sig)) {
    return new NextResponse(
      page("That link didn't verify.", "It may have been truncated by your mail client. You can manage email in your account settings."),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const form =
    `<form method="post" style="margin-top:8px">` +
    `<button type="submit" style="font:inherit;font-weight:600;background:#1f3a8a;color:#fff;border:0;border-radius:8px;padding:11px 20px;cursor:pointer">Unsubscribe from ${LABEL[scope as Scope]}</button>` +
    `</form><p style="color:#888;font-size:13px;margin-top:14px">Or manage everything in your <a href="/settings" style="color:#1f3a8a">email preferences</a>.</p>`;
  return new NextResponse(
    page("Confirm unsubscribe", `Click below to stop receiving ${LABEL[scope as Scope]}.${form}`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Replen</title></head>` +
    `<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#1a1a1a;text-align:center">` +
    `<div style="font-size:18px;font-weight:700;color:#1f3a8a;margin-bottom:24px">Replen</div>` +
    `<h1 style="font-size:22px;margin:0 0 10px">${title}</h1>` +
    `<p style="color:#555;line-height:1.6">${body}</p>` +
    `</body></html>`;
}
