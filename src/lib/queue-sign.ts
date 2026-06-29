// Signed queue-add links for emails. The brief/alert emails carry per-item
// "queue this" links; embedding the digest token in mail would leak it on
// forward, so links are HMAC-signed over their own parameters instead — the
// signature authorises exactly one (user, kind, ref, title) insertion and
// nothing else. Key: ENCRYPTION_KEY (already required in prod for at-rest
// secrets).

import { createHmac, timingSafeEqual, type BinaryLike } from "node:crypto";
import { linkSigningKey, legacyLinkSigningKey } from "./crypto";

// Length-prefixed field encoding so no attacker-controlled value (kind/title)
// can shift a delimiter to forge a different (user, kind, ref, title) tuple
// that signs identically. Full 64-hex digest (not truncated).
function signingBasis(userId: number, kind: string, refId: number | null, title: string): string {
  const parts = [String(userId), kind, refId != null ? String(refId) : "", title];
  return parts.map((p) => `${p.length}:${p}`).join("");
}

const hmac = (k: BinaryLike, basis: string): string => createHmac("sha256", k).update(basis).digest("hex");
const ctEq = (sig: string, expected: string): boolean => {
  if (typeof sig !== "string" || sig.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); } catch { return false; }
};

export function signQueueParams(userId: number, kind: string, refId: number | null, title: string): string {
  return hmac(linkSigningKey(), signingBasis(userId, kind, refId, title));
}

// Constant-time verification — never compare signatures with === (timing oracle).
// Accepts the new domain-separated key OR the legacy raw-master key, so links
// already sent in emails keep verifying through the transition.
export function verifyQueueParams(userId: number, kind: string, refId: number | null, title: string, sig: string): boolean {
  const basis = signingBasis(userId, kind, refId, title);
  return ctEq(sig, hmac(linkSigningKey(), basis)) || ctEq(sig, hmac(legacyLinkSigningKey(), basis));
}

export function queueAddUrl(userId: number, kind: string, refId: number | null, title: string): string {
  const base = (process.env.CLI_PUBLIC_BASE_URL ?? "https://app.replen.dev").replace(/\/+$/, "");
  const t = title.slice(0, 140);
  const params = new URLSearchParams({
    u: String(userId),
    k: kind,
    r: refId != null ? String(refId) : "",
    t,
    sig: signQueueParams(userId, kind, refId, t),
  });
  return `${base}/api/queue/add?${params.toString()}`;
}
