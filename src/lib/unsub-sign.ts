// Signed unsubscribe / email-preference links. Same rationale as queue-sign:
// never embed the digest token in mail (it leaks on forward). An HMAC over
// (userId, scope) authorises flipping exactly that user's email preference and
// nothing else — a forwarded link can't unsubscribe a different user or a
// different channel. Key: ENCRYPTION_KEY (already required in prod).

import { createHmac, timingSafeEqual, type BinaryLike } from "node:crypto";
import { linkSigningKey, legacyLinkSigningKey } from "./crypto";

export type UnsubScope = "all" | "brief" | "alerts" | "digest";
const SCOPES: readonly string[] = ["all", "brief", "alerts", "digest"];

// Length-prefixed encoding so no field can shift a delimiter to forge a different
// (user, scope) tuple that signs identically. Full 64-hex digest.
function basis(userId: number, scope: string): string {
  return [String(userId), scope].map((p) => `${p.length}:${p}`).join("");
}

const hmac = (k: BinaryLike, b: string): string => createHmac("sha256", k).update(b).digest("hex");
const ctEq = (sig: string, expected: string): boolean => {
  if (typeof sig !== "string" || sig.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); } catch { return false; }
};

export function signUnsub(userId: number, scope: UnsubScope): string {
  return hmac(linkSigningKey(), basis(userId, scope));
}

// Constant-time verification — never compare signatures with === (timing oracle).
// Accepts the new domain-separated key OR the legacy raw-master key so links in
// already-sent emails keep working through the transition.
export function verifyUnsub(userId: number, scope: string, sig: string): boolean {
  if (!SCOPES.includes(scope)) return false;
  const b = basis(userId, scope as UnsubScope);
  return ctEq(sig, hmac(linkSigningKey(), b)) || ctEq(sig, hmac(legacyLinkSigningKey(), b));
}

function baseUrl(): string {
  // The WEBAPP base (Dashboard / settings / unsubscribe live here) — app.replen.dev.
  // NOT PUBLIC_BASE_URL, which is the skill-tier API host (skill.replen.dev) and
  // 302-redirects browser/image requests. Matches queue-sign's resolution.
  return (process.env.CLI_PUBLIC_BASE_URL ?? "https://app.replen.dev").replace(/\/+$/, "");
}

export function unsubscribeUrl(userId: number, scope: UnsubScope): string {
  const params = new URLSearchParams({ u: String(userId), s: scope, sig: signUnsub(userId, scope) });
  return `${baseUrl()}/api/email/unsubscribe?${params.toString()}`;
}

/** Link to the account email-preferences page (no token — it's behind auth). */
export function prefsUrl(): string {
  return `${baseUrl()}/settings`;
}

/** Dashboard link for email footers. */
export function dashboardUrl(): string {
  return baseUrl();
}
