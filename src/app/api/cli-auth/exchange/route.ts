import { NextResponse } from "next/server";
import { redeemCliAuthCode } from "@/lib/cli-auth-codes";

// One-time exchange code → ingest token redemption. The CLI's local listener
// receives a `code` query param via the browser callback and POSTs it here
// server-to-server (no browser involvement). The plaintext token never appears
// in any URL.
//
// Single-use: even on state mismatch the code is consumed (so a brute-force
// state probe can only burn the code once). Belt-and-braces per-IP bucket
// below (audit H2) caps brute force at 10 attempts / minute / IP even if the
// nginx-layer limit is misconfigured.

// Per-IP token bucket. Keyed by the connecting IP (X-Forwarded-For when
// nginx is in front, else req.ip). Tiny in-memory store; sweep stale
// entries on every call. Single-replica deployment so a global Map is fine.
type Bucket = { tokens: number; refilledAt: number };
const buckets = new Map<string, Bucket>();
const RATE_REFILL_MS = 60_000; // 10 reqs / minute
const RATE_CAPACITY = 10;
function takeBucketToken(ip: string): boolean {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: RATE_CAPACITY, refilledAt: now };
    buckets.set(ip, b);
  }
  // Refill linearly: tokens granted proportional to elapsed time.
  const elapsed = now - b.refilledAt;
  if (elapsed > 0) {
    const refill = (elapsed / RATE_REFILL_MS) * RATE_CAPACITY;
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + refill);
    b.refilledAt = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  // Opportunistic sweep so the map doesn't grow unbounded.
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) {
      if (now - v.refilledAt > 5 * RATE_REFILL_MS) buckets.delete(k);
    }
  }
  return true;
}

function callerIp(req: Request): string {
  // Prefer nginx's X-Real-IP (set by our upstream config) over the first
  // X-Forwarded-For value — XFF is appendable by the client and would let
  // an attacker rotate IPs per request to sidestep the per-IP rate bucket.
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

export async function POST(req: Request) {
  if (!takeBucketToken(callerIp(req))) {
    return NextResponse.json({ ok: false, error: "rate limit" }, { status: 429 });
  }
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
    console.warn(`[/api/cli-auth/exchange] redeem failed ip=${callerIp(req)} reason=${r.error}`);
    return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, token: r.token, base: r.base });
}

export async function OPTIONS() {
  // No CORS allowed-origin: this endpoint is intended for server-to-server
  // POSTs from the CLI's localhost process, not browser requests.
  return new NextResponse(null, { status: 204 });
}
