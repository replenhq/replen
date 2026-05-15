import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

const ALLOWED = new Set(["good", "bad", "clear", "star", "unstar", "hide"]);

// POST /api/mcp/feedback  body: { matchId, action }
//   action: 'good' | 'bad' | 'clear' (userFeedback) | 'star' | 'unstar' | 'hide' (userStatus)
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: { matchId?: number; action?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders }); }
  const matchId = Number(body.matchId);
  const action = body.action ?? "";
  if (!Number.isInteger(matchId) || matchId <= 0) return NextResponse.json({ error: "matchId required" }, { status: 400, headers: corsHeaders });
  if (!ALLOWED.has(action)) return NextResponse.json({ error: `action must be one of ${[...ALLOWED].join(",")}` }, { status: 400, headers: corsHeaders });

  if (action === "star" || action === "unstar" || action === "hide") {
    const status = action === "star" ? "starred" : action === "unstar" ? "unread" : "hidden";
    await db.update(schema.matches).set({ userStatus: status }).where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, auth.userId)));
  } else {
    await db.update(schema.matches).set({ userFeedback: action === "clear" ? null : action }).where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, auth.userId)));
  }
  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }
