import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authMiddleware, redirectToLogin } from "next-firebase-auth-edge";
import { authConfig } from "@/lib/auth/config";

const PUBLIC_PATHS = ["/login", "/api/login", "/api/logout"];

function isPublic(pathname: string) {
  if (pathname.startsWith("/_next/") || pathname.includes(".")) return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Content-Security-Policy + companion headers. Defence-in-depth: if a future
// XSS bug slips in, CSP gates what attacker scripts can do (no eval, no
// arbitrary script src, no exfil to random origins).
//
// What's whitelisted and why:
//  - script-src self + gstatic + apis.google.com: Firebase Auth SDK
//  - 'unsafe-inline' on style-src: Next.js + React inline styles
//  - 'unsafe-inline' / 'unsafe-eval' on script-src: Next.js's hydration bundle
//    requires inline scripts. Using a nonce would be safer; revisit if any
//    inline scripts originate from user input (today, none do).
//  - frame-src threads.com / tiktok.com: the SourcePost video embeds.
//  - connect-src to firebaseapp / googleapis / securetoken: Firebase Auth.
//  - frame-ancestors 'none': prevents anyone from iframing us (clickjacking).
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com https://apis.google.com https://*.firebaseapp.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com",
  "frame-src 'self' https://www.threads.com https://www.tiktok.com",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

function applySecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("Content-Security-Policy", CSP_DIRECTIVES);
  // X-Frame-Options is redundant with frame-ancestors but adds coverage for
  // older browsers that don't enforce the CSP directive.
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  // HSTS: only meaningful behind HTTPS — nginx already enforces TLS in front
  // of this app, so flag the upgrade. 6 months + preload-ready value.
  res.headers.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  return res;
}

export async function middleware(request: NextRequest) {
  // /api/sync still uses x-sync-token; keep public (the route checks its own auth).
  if (request.nextUrl.pathname.startsWith("/api/sync")) {
    return applySecurityHeaders(NextResponse.next());
  }
  // /api/whoami: public diagnostic; the route itself reports session state.
  if (request.nextUrl.pathname === "/api/whoami") {
    return applySecurityHeaders(NextResponse.next());
  }
  // /api/ingest: per-user token auth from the route; bookmarklets POST here
  // from any origin (CORS preflight is OPTIONS).
  if (request.nextUrl.pathname.startsWith("/api/ingest")) {
    return applySecurityHeaders(NextResponse.next());
  }
  // /api/mcp/*: MCP server calls from the user's local machine. Token auth
  // is enforced in each route; CORS is permissive on those paths.
  if (request.nextUrl.pathname.startsWith("/api/mcp/")) {
    return applySecurityHeaders(NextResponse.next());
  }

  return authMiddleware(request, {
    ...authConfig,
    loginPath: "/api/login",
    logoutPath: "/api/logout",
    handleValidToken: async (_tokens, headers) => {
      return applySecurityHeaders(NextResponse.next({ request: { headers } }));
    },
    handleInvalidToken: async (reason) => {
      if (isPublic(request.nextUrl.pathname)) return applySecurityHeaders(NextResponse.next());
      return applySecurityHeaders(redirectToLogin(request, { path: "/login", publicPaths: PUBLIC_PATHS }));
    },
    handleError: async (error) => {
      console.error("[auth middleware]", error);
      if (isPublic(request.nextUrl.pathname)) return applySecurityHeaders(NextResponse.next());
      return applySecurityHeaders(redirectToLogin(request, { path: "/login", publicPaths: PUBLIC_PATHS }));
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
