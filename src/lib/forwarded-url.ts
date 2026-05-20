// Public-URL reconstruction from X-Forwarded-* headers.
//
// Behind nginx + cloudflared, the Next.js server only sees the
// upstream loopback URL (e.g. http://127.0.0.1:3030/demo) — not the
// public host the user actually visited (https://app.replen.dev/demo).
// `new URL("/", request.url)` therefore builds a localhost target,
// which the browser refuses to follow.
//
// nginx-replen.conf already forwards X-Forwarded-Host + X-Forwarded-Proto
// (per the deployed template). This helper turns those into a clean URL
// that points at the public origin, with the upstream port stripped so
// users never see `:3030` in the address bar.

import { NextRequest } from "next/server";

export function publicUrlFrom(request: NextRequest, pathname: string): URL {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const base = new URL(request.url);
  if (forwardedProto) base.protocol = `${forwardedProto}:`;
  if (forwardedHost) {
    // X-Forwarded-Host may carry an explicit port (e.g. "host:8080");
    // honour it if so, otherwise clear the inherited upstream port so
    // the redirect URL doesn't leak `:3030`.
    const [hostname, port] = forwardedHost.split(":");
    base.hostname = hostname;
    base.port = port ?? "";
  }
  return new URL(pathname, base);
}
