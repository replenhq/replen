// Short-lived in-memory exchange codes for the CLI authorize flow.
//
// Flow:
//   1. Browser hits /cli-auth → user clicks Authorize → server mints a fresh
//      ingest token (plaintext), stores ONLY its sha256 hash, and creates an
//      exchange code that holds the plaintext in memory keyed by code+state.
//   2. Browser is redirected to http://127.0.0.1:<port>/callback?code=<code>
//      &state=<state>. No token in the URL.
//   3. CLI's local listener receives the code, then POSTs server-to-server to
//      /api/cli-auth/exchange with {code, state}. The endpoint pops the entry
//      and returns the plaintext token. Code is single-use.
//
// In-memory only: a process restart loses pending codes. Acceptable for a
// 2-minute window on a single replica; the user just re-runs `npx replen`.
//
// Bundle-shared state via globalThis (fix 2026-05-22). Next.js 16's production
// bundler can place a server action (`authorizeCli` in cli-auth/actions.ts)
// and an API route handler (`/api/cli-auth/exchange`) into separate runtime
// chunks. Without globalThis-pinning, each chunk would receive its own copy
// of the module-scoped `codes` Map: mint stores in chunk A's Map; redeem
// reads from chunk B's empty Map; every CLI auth attempt fails with "unknown
// or expired code." Pinning to globalThis ensures every chunk in this Node
// process resolves to the same Map instance, restoring the intended
// single-process semantics.

import { randomBytes, timingSafeEqual } from "node:crypto";

// Constant-time string compare (length-checked). The state compare below has no
// timing oracle in practice (the code is single-use and deleted before compare),
// but this keeps every auth-gating comparison uniformly constant-time.
const ctEqStr = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

type Entry = { token: string; base: string; userId: number; state: string; expiresAt: number };

const g = globalThis as unknown as { __replenCliAuthCodes?: Map<string, Entry> };
g.__replenCliAuthCodes ??= new Map<string, Entry>();
const codes = g.__replenCliAuthCodes;
const TTL_MS = 2 * 60 * 1000;

function purge(): void {
  const now = Date.now();
  for (const [k, v] of codes) {
    if (v.expiresAt < now) codes.delete(k);
  }
}

export function issueCliAuthCode(userId: number, token: string, base: string, state: string): string {
  purge();
  const code = "cac_" + randomBytes(24).toString("base64url");
  codes.set(code, {
    token,
    base,
    userId,
    state,
    expiresAt: Date.now() + TTL_MS,
  });
  return code;
}

export type RedeemResult =
  | { ok: true; token: string; base: string; userId: number }
  | { ok: false; error: string };

export function redeemCliAuthCode(code: string, state: string): RedeemResult {
  purge();
  const entry = codes.get(code);
  if (!entry) return { ok: false, error: "unknown or expired code" };
  // Single-use: delete on first read regardless of state-match outcome so a
  // brute-force loop can't probe state values.
  codes.delete(code);
  if (!ctEqStr(entry.state, state)) return { ok: false, error: "state mismatch" };
  if (entry.expiresAt < Date.now()) return { ok: false, error: "code expired" };
  return { ok: true, token: entry.token, base: entry.base, userId: entry.userId };
}
