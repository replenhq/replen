// SSRF defence for outbound webhook URLs. The user-controlled webhook URL on
// /settings is POSTed to from inside the VPS, which means a malicious value
// could probe internal services (169.254.169.254, 127.0.0.1, RFC1918) and
// reflect responses in surfaced error messages.
//
// Two-layer guard:
//   1. validateWebhookUrl(): synchronous, syntactic. Enforces scheme, rejects
//      IP-literal hostnames and obvious internal names. Called on save.
//   2. resolveSafe(): async, DNS-resolves the hostname and rejects if any
//      resolved IP falls into a private / loopback / link-local / multicast
//      range. Called immediately before each fetch in the webhook sender to
//      defeat DNS rebinding (where validate-time and fetch-time resolution
//      differ).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Hostnames that should never be reached outbound regardless of how they
// resolve. Defence in depth on top of the IP-range check below.
const BLOCKED_HOSTS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
]);

export type UrlGuardResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

export function validateWebhookUrl(input: string): UrlGuardResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "URL required" };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }
  if (u.protocol !== "https:") {
    return { ok: false, error: "Webhook must be https://" };
  }
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, error: "Missing hostname" };
  if (BLOCKED_HOSTS.has(host)) return { ok: false, error: "Hostname is not allowed" };
  // Reject IP literals at save time. Public services should be addressed by
  // hostname. (Bare-IP allowlists are an explicit footgun.)
  if (isIP(host) !== 0) {
    return { ok: false, error: "IP-literal hostnames are not allowed; use a domain name" };
  }
  // Common-sense suffix rejections: anything under .local, .internal,
  // .corp, .home, .lan is treated as private regardless of DNS resolution.
  if (/\.(local|internal|corp|home|lan|intranet)$/i.test(host)) {
    return { ok: false, error: "Internal-zone hostname is not allowed" };
  }
  return { ok: true, url: u };
}

// Returns true if the IPv4/IPv6 address falls into a private / loopback /
// link-local / multicast / reserved range. Used to reject the resolved
// addresses of a webhook hostname.
function isPrivateAddress(addr: string, family: number): boolean {
  if (family === 4) {
    const parts = addr.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts;
    // 10/8, 172.16/12, 192.168/16
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Loopback 127/8
    if (a === 127) return true;
    // Link-local 169.254/16 (incl. AWS/GCP metadata at 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // Carrier-grade NAT 100.64/10
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 0.0.0.0/8 and 255.255.255.255 broadcast
    if (a === 0) return true;
    if (a === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;
    // Multicast 224/4 and reserved 240/4
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fec0:")) return true; // site-local (deprecated)
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped IPv6: ::ffff:a.b.c.d → re-check as v4
    const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4mapped) return isPrivateAddress(v4mapped[1], 4);
    return false;
  }
  return true;
}

export async function resolveSafe(url: URL): Promise<UrlGuardResult> {
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return { ok: false, error: "Hostname blocked" };
  if (isIP(host) !== 0) return { ok: false, error: "IP-literal hostnames are not allowed" };
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    return { ok: false, error: `DNS lookup failed: ${(e as Error).message}` };
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address, a.family)) {
      return { ok: false, error: `Resolved address ${a.address} is in a private range` };
    }
  }
  return { ok: true, url };
}
