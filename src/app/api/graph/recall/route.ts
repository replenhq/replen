import { NextResponse } from "next/server";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { allowAction, WRITE_LIMIT, WRITE_WINDOW_MS } from "@/lib/rate-limit";
import { recall } from "@/graph/recall";

// Atlas §2 — Recall. In-session memory across the user's whole portfolio + their
// decision history. POST { query, verdict?, limit? }

const VALID_VERDICTS = new Set(["adopt", "port", "cherry-pick", "clean-room", "upgrade", "skip", "defer"]);

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  // recall() runs a server-paid embedding query per request — rate limit it.
  if (!allowAction(`recall:${auth.userId}`, WRITE_LIMIT, WRITE_WINDOW_MS)) {
    return NextResponse.json({ error: "rate limit exceeded, slow down" }, { status: 429, headers: corsHeaders });
  }
  let body: { query?: string; verdict?: string; limit?: number } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query && !body.verdict) {
    return NextResponse.json({ error: "provide a query (and/or a verdict filter)" }, { status: 400, headers: corsHeaders });
  }
  const verdict = body.verdict && VALID_VERDICTS.has(body.verdict) ? body.verdict : undefined;
  const limit = Math.min(20, Math.max(1, body.limit ?? 8));
  const data = await recall(auth.userId, { query, verdict, limit });
  return NextResponse.json(data, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
