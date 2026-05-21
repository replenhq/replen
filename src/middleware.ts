import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authMiddleware, redirectToLogin } from "next-firebase-auth-edge";
import { authConfig } from "@/lib/auth/config";

const PUBLIC_PATHS = ["/login", "/api/login", "/api/logout", "/signed-out", "/demo"];

function isPublic(pathname: string) {
  if (pathname.startsWith("/_next/") || pathname.includes(".")) return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Content-Security-Policy + companion headers. Defence-in-depth: if a future
// XSS bug slips in, CSP gates what attacker scripts can do (no eval, no
// arbitrary script src, no exfil to random origins).
//
// Per-request nonce strategy: a 16-byte random nonce is generated, set on
// both the request header `x-nonce` (read by server components / next/script)
// and the response CSP header (`script-src 'nonce-XYZ' 'strict-dynamic'`).
// 'strict-dynamic' lets Next.js's bundled boot scripts (which inherit the
// nonce automatically since Next 13.4+) load further chunks without
// individually whitelisting each one.
//
// What's whitelisted and why:
//  - script-src 'self' + nonce: our own scripts (+ Next bundles via nonce)
//  - style-src 'unsafe-inline': React inline styles. Style-only XSS has very
//    limited blast radius; the alternative is nonce-on-every-style which
//    breaks third-party SVGs etc.
//  - img-src https: allow any image src (GitHub avatars, etc.)
//  - frame-src threads.com / tiktok.com: the source-post video embeds.
//  - connect-src to firebaseapp / googleapis / securetoken: Firebase Auth.
//  - frame-ancestors 'none': prevents anyone from iframing us (clickjacking).
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://www.gstatic.com https://apis.google.com https://*.firebaseapp.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // Firebase Auth XHRs go through identitytoolkit + securetoken + the
    // hosted auth handler on *.firebaseapp.com. The OAuth popup also relays
    // state back to the parent via that same origin.
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com https://*.firebaseapp.com",
    // *.firebaseapp.com is the hosted Firebase Auth iframe used to sync
    // popup state with the parent page during signInWithPopup. Without it,
    // GitHub / Google / magic-link sign-ins all fail silently with
    // "popup-closed-by-user" because the iframe load is blocked by CSP.
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://www.threads.com https://www.tiktok.com",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function generateNonce(): string {
  // 16 random bytes → 22 base64 chars; well above the OWASP-recommended 128
  // bits of entropy for a CSP nonce.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function applySecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set("Content-Security-Policy", buildCsp(nonce));
  res.headers.set("x-nonce", nonce);
  // X-Frame-Options is redundant with frame-ancestors but adds coverage for
  // older browsers that don't enforce the CSP directive.
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  // HSTS: only meaningful behind HTTPS - nginx already enforces TLS in front
  // of this app, so flag the upgrade. 6 months + preload-ready value.
  res.headers.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  return res;
}

// Cloudflare-only origin enforcement. When REQUIRE_CLOUDFLARE=1, every request
// must arrive via Cloudflare. We check both:
//   1. CF-Connecting-IP must be present (Cloudflare always sets this on
//      forwarded requests; clients connecting directly to the origin IP do
//      not).
//   2. If CF_ORIGIN_SECRET is set, the request must carry x-replen-edge-secret
//      with the same value. Pair this with a Cloudflare Transform Rule that
//      injects the secret on every forwarded request (Rules → Transform →
//      Modify Request Header → Set static).
//
// Reject with 421 Misdirected Request, no body, no security headers (we
// don't want to leak that this is a replen origin). Health endpoints bypass.
function rejectIfNotCloudflare(request: NextRequest): NextResponse | null {
  if (process.env.REQUIRE_CLOUDFLARE !== "1") return null;
  const path = request.nextUrl.pathname;
  // Allow local healthchecks via loopback - typically used by systemd / nginx upstream probes.
  if (path === "/api/whoami" || path === "/api/healthz") return null;
  const cfIp = request.headers.get("cf-connecting-ip");
  if (!cfIp) {
    return new NextResponse(null, { status: 421 });
  }
  const expected = process.env.CF_ORIGIN_SECRET;
  if (expected) {
    const got = request.headers.get("x-replen-edge-secret");
    if (!got || got !== expected) {
      return new NextResponse(null, { status: 421 });
    }
  }
  return null;
}

export async function middleware(request: NextRequest) {
  const reject = rejectIfNotCloudflare(request);
  if (reject) return reject;

  const nonce = generateNonce();
  // Forward nonce to the app via request header so server components / next/script
  // can pick it up via headers().get("x-nonce").
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("x-nonce", nonce);
  // Always strip the incoming x-replen-on-demo header before we conditionally
  // re-set it. Without this, a client could send x-replen-on-demo: 1 on a
  // non-demo URL and the root layout would render the demo banner + chrome
  // over their real account (phishing / UI-spoof).
  forwardedHeaders.delete("x-replen-on-demo");

  // /demo and /demo/* are real, public Next.js routes — no auth gate,
  // no cookie, no rewrite. They render the seeded demo user's data
  // directly. authMiddleware below treats them as public via PUBLIC_PATHS.
  //
  // Tag /demo/* requests with x-replen-on-demo so the root layout knows
  // to render the demo header chrome + banner regardless of whether a
  // real user is also logged in. handleValidToken / handleInvalidToken
  // below forward this header through to RSC.
  const isDemoPath = request.nextUrl.pathname === "/demo" || request.nextUrl.pathname.startsWith("/demo/");
  if (isDemoPath) {
    forwardedHeaders.set("x-replen-on-demo", "1");
  }

  // /api/sync still uses x-sync-token; keep public (the route checks its own auth).
  if (request.nextUrl.pathname.startsWith("/api/sync")) {
    return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
  }
  // /api/whoami: public diagnostic; the route itself reports session state.
  if (request.nextUrl.pathname === "/api/whoami") {
    return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
  }
  // /api/healthz: public liveness/readiness probe for uptime monitors.
  // Pings the sqlite; returns 200/503. No auth, no cookies, no body
  // beyond a tiny JSON status.
  if (request.nextUrl.pathname === "/api/healthz") {
    return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
  }
  // /api/ingest: per-user token auth from the route; bookmarklets POST here
  // from any origin (CORS preflight is OPTIONS).
  if (request.nextUrl.pathname.startsWith("/api/ingest")) {
    return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
  }
  // /api/mcp/*: MCP server calls from the user's local machine. Token auth
  // is enforced in each route.
  if (request.nextUrl.pathname.startsWith("/api/mcp/")) {
    return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
  }
  // /api/cli-auth/exchange: one-time exchange code redemption. Route enforces
  // state matching and 2-min TTL; no Firebase session needed.
  if (request.nextUrl.pathname.startsWith("/api/cli-auth/exchange")) {
    return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
  }

  return authMiddleware(request, {
    ...authConfig,
    loginPath: "/api/login",
    // Point logoutPath at a path that's never routed to. The library
    // requires the option to be set, but its built-in handler just
    // returns `{success: true}` JSON — we want the user to land on
    // a proper /signed-out page instead. Our own /api/logout/route.ts
    // clears the cookies AND redirects, and runs unimpeded because
    // the lib never sees a request to this sentinel path.
    logoutPath: "/__lib_logout_unused",
    handleValidToken: async (_tokens, headers) => {
      const merged = new Headers(headers);
      merged.set("x-nonce", nonce);
      // Strip client-supplied x-replen-on-demo before conditionally setting it,
      // same as the forwardedHeaders path above.
      merged.delete("x-replen-on-demo");
      if (isDemoPath) merged.set("x-replen-on-demo", "1");
      return applySecurityHeaders(NextResponse.next({ request: { headers: merged } }), nonce);
    },
    handleInvalidToken: async () => {
      if (isPublic(request.nextUrl.pathname)) return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
      return applySecurityHeaders(redirectToLogin(request, { path: "/login", publicPaths: PUBLIC_PATHS }), nonce);
    },
    handleError: async (error) => {
      console.error("[auth middleware]", error);
      if (isPublic(request.nextUrl.pathname)) return applySecurityHeaders(NextResponse.next({ request: { headers: forwardedHeaders } }), nonce);
      return applySecurityHeaders(redirectToLogin(request, { path: "/login", publicPaths: PUBLIC_PATHS }), nonce);
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
