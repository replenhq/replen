"use server";

import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { randomBytes } from "crypto";
import { hashIngestToken } from "@/lib/crypto";
import { issueCliAuthCode } from "@/lib/cli-auth-codes";

export type AuthorizeResult =
  | { ok: true; callback: string }
  | { ok: false; error: string };

// Each authorize mints a NEW ingest token: we only persist the sha256 hash in
// the DB, so reusing the same plaintext across authorizations isn't possible
// (and is also a desirable security property — pressing Authorize rotates the
// credential and invalidates anything the previous holder kept).
//
// The plaintext does NOT leave the server in the redirect URL. Instead we
// issue a short-lived (2-min, single-use) exchange code. The browser redirect
// carries only the code; the CLI redeems it server-to-server against
// /api/cli-auth/exchange.
export async function authorizeCli(port: number, state: string): Promise<AuthorizeResult> {
  const u = await requireUser();

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, error: "Invalid port" };
  }
  if (!/^[a-f0-9]{32,128}$/i.test(state)) {
    return { ok: false, error: "Invalid state" };
  }

  const token = "ing_" + randomBytes(24).toString("base64url");
  const hash = hashIngestToken(token);

  const existing = await db
    .select({ id: schema.userSettings.id })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, u.id))
    .get();
  // 90-day expiry: long enough that users don't re-auth often, short enough
  // that a token from a forgotten device aged out can't be used forever.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
  if (existing) {
    await db
      .update(schema.userSettings)
      .set({
        ingestTokenHash: hash,
        ingestTokenExpiresAt: expiresAt,
        ingestTokenLastUsedAt: null, // reset on re-issue
        updatedAt: now,
      })
      .where(eq(schema.userSettings.userId, u.id));
  } else {
    await db.insert(schema.userSettings).values({
      userId: u.id,
      ingestTokenHash: hash,
      ingestTokenExpiresAt: expiresAt,
      ingestTokenLastUsedAt: null,
      updatedAt: now,
    });
  }

  // The CLI talks to the public API origin, which is NOT necessarily
  // PUBLIC_BASE_URL — in prod that points at a Cloudflare-gated marketing host
  // (skill.replen.dev) the CLI can't reach. Resolve the CLI's base independently
  // and default to the public app origin so a missing env can't hand the CLI a
  // host it can't call. Matches the CLI's own default (cli/src/init.ts).
  const base = process.env.CLI_PUBLIC_BASE_URL || "https://app.replen.dev";
  const code = issueCliAuthCode(u.id, token, base, state);
  const cb = new URL(`http://127.0.0.1:${port}/callback`);
  cb.searchParams.set("code", code);
  cb.searchParams.set("state", state);
  return { ok: true, callback: cb.toString() };
}
