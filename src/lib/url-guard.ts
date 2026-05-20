// SSRF defence for outbound URLs. Two-layer guard: validateWebhookUrl()
// rejects syntactically risky inputs at save time; resolveSafe() and
// resolveSafeWithPinnedDispatcher() resolve DNS at fetch time and refuse
// anything in a private / loopback / link-local / multicast range. Pinning
// the resolved IP through an undici Agent defeats DNS-rebinding races.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  // Cloud metadata service shorthands. The numeric IP-literal
  // 169.254.169.254 is already caught by the isIP / private-range
  // check below; these are the case-collapse-friendly hostnames
  // that resolve to it on AWS, GCP, Azure, and cloud-init.
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
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
  if (isIP(host) !== 0) {
    return { ok: false, error: "IP-literal hostnames are not allowed; use a domain name" };
  }
  if (/\.(local|internal|corp|home|lan|intranet)$/i.test(host)) {
    return { ok: false, error: "Internal-zone hostname is not allowed" };
  }
  return { ok: true, url: u };
}

function isPrivateAddress(addr: string, family: number): boolean {
  if (family === 4) {
    const parts = addr.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
    if (a === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fec0:")) return true; // site-local (deprecated)
    if (lower.startsWith("ff")) return true; // multicast
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

export type PinnedResult =
  | { ok: true; url: URL; dispatcher: Agent }
  | { ok: false; error: string };

// Resolve + validate the hostname once and pin the result through the
// dispatcher's connect step. A hostile resolver returning a public IP at
// validate-time and a private IP at fetch-time cannot win the race because
// the connection uses the address we already approved. Hostname stays for
// TLS SNI / cert verification.
export async function resolveSafeWithPinnedDispatcher(url: URL): Promise<PinnedResult> {
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return { ok: false, error: "Hostname blocked" };
  if (isIP(host) !== 0) return { ok: false, error: "IP-literal hostnames are not allowed" };
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    return { ok: false, error: `DNS lookup failed: ${(e as Error).message}` };
  }
  const pickable = addrs.filter((a) => !isPrivateAddress(a.address, a.family));
  if (pickable.length === 0) {
    const bad = addrs[0]?.address ?? "unknown";
    return { ok: false, error: `Resolved address ${bad} is in a private range` };
  }
  const picked = pickable[0];
  const dispatcher = new Agent({
    connect: {
      // undici's connect.lookup follows Node's net.LookupFunction signature, which
      // has TWO callback shapes depending on options.all:
      //   - opts.all === true  → cb(err, [{address, family}])
      //   - opts.all !== true  → cb(err, address, family)
      // Newer undici (>= ~6.x bundled by Next.js) sets all: true and reads
      // result[0].address. If we always call the second shape, that read yields
      // undefined and undici throws ERR_INVALID_IP_ADDRESS *before* any network
      // call — which is exactly the "TypeError: fetch failed" you see in logs.
      // Handle both shapes to stay compatible across undici versions.
      lookup: (_hostname, opts, cb) => {
        if ((opts as { all?: boolean } | null | undefined)?.all) {
          (cb as (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(
            null,
            [{ address: picked.address, family: picked.family }],
          );
        } else {
          cb(null, picked.address, picked.family as 4 | 6);
        }
      },
    },
  });
  return { ok: true, url, dispatcher };
}
