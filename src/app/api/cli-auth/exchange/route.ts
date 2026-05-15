import { NextResponse } from "next/server";
import { redeemCliAuthCode } from "@/lib/cli-auth-codes";

// One-time exchange code → ingest token redemption. The CLI's local listener
// receives a `code` query param via the browser callback and POSTs it here
// server-to-server (no browser involvement). The plaintext token never appears
// in any URL.
//
// Single-use: even on state mismatch the code is consumed (so a brute-force
// state probe can only burn the code once).
export async function POST(req: Request) {
  let body: { code?: string; state?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const code = (body.code ?? "").trim();
  const state = (body.state ?? "").trim();
  if (!/^cac_[A-Za-z0-9_-]{16,}$/.test(code)) {
    return NextResponse.json({ ok: false, error: "invalid code" }, { status: 400 });
  }
  if (!/^[a-f0-9]{32,128}$/i.test(state)) {
    return NextResponse.json({ ok: false, error: "invalid state" }, { status: 400 });
  }
  const r = redeemCliAuthCode(code, state);
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, token: r.token, base: r.base });
}

export async function OPTIONS() {
  // No CORS allowed-origin: this endpoint is intended for server-to-server
  // POSTs from the CLI's localhost process, not browser requests.
  return new NextResponse(null, { status: 204 });
}
