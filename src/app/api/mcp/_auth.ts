import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { hashIngestToken } from "@/lib/crypto";
import { isDemoUser } from "@/lib/auth/demo-mode";

// Token auth shared by every /api/mcp/* endpoint. The MCP server passes the
// user's personal token in either header - `x-digest-token` is preferred,
// `x-ingest-token` accepted for symmetry with /api/ingest (same token).
//
// The token is never compared against plaintext in the DB. Lookup is by
// sha256(token) so a DB leak doesn't yield reusable tokens. See
// src/lib/crypto.ts:hashIngestToken.
export type McpAuth = {
  userId: number;
  settings: typeof schema.userSettings.$inferSelect;
};

export async function authenticate(req: Request): Promise<McpAuth | null> {
  const token = req.headers.get("x-digest-token") ?? req.headers.get("x-ingest-token");
  if (!token) return null;
  const hash = hashIngestToken(token);
  const row = await db
    .select({ settings: schema.userSettings, status: schema.users.status, email: schema.users.email })
    .from(schema.userSettings)
    .innerJoin(schema.users, eq(schema.users.id, schema.userSettings.userId))
    .where(eq(schema.userSettings.ingestTokenHash, hash))
    .get();
  if (!row) return null;
  // Status gate: a pending or suspended user must not be able to drive the
  // ingest / MCP API even if they hold a previously-minted token. Without
  // this check, demoting a user on /admin had no effect on their token-based
  // surface — they could keep writing candidates, reading matches, and
  // opening handoff PRs indefinitely.
  if (row.status !== "active") return null;
  // Demo gate: the seeded demo account is read-only everywhere else (server
  // actions go through requireWritableUser). A minted demo token must not be a
  // back door into the token-authed write routes, so refuse it outright here.
  if (isDemoUser({ email: row.email })) return null;
  // Expiry gate (audit H1). NULL expiry on legacy pre-0028 rows is treated
  // as non-expiring back-compat; new tokens from authorizeCli always carry
  // a 90-day stamp. Once a token is past its expiry the user must run the
  // CLI auth flow again — a leaked token can't be used forever.
  const expiresAt = row.settings.ingestTokenExpiresAt;
  if (expiresAt && +expiresAt < Date.now()) return null;
  // Stamp last-used so /settings can surface stale-or-suspicious tokens.
  // Fire-and-forget: don't slow the request on a slow disk; if the update
  // fails the API call still succeeds.
  void db
    .update(schema.userSettings)
    .set({ ingestTokenLastUsedAt: new Date() })
    .where(eq(schema.userSettings.id, row.settings.id))
    .catch((e) => console.warn(`[_auth] last-used stamp failed: ${(e as Error).message}`));
  return { userId: row.settings.userId, settings: row.settings };
}

// MCP servers run as a Node process on the user's machine (stdio transport)
// and call our API server-to-server, so they never originate a CORS preflight.
// We therefore deliberately do NOT set Access-Control-Allow-Origin: any
// browser-context cross-origin call to these endpoints should fail at the
// browser's CORS check, even if it carries a stolen token. The previous
// wildcard policy was a leftover from when this was misclassified as a
// bookmarklet-style endpoint.
export const corsHeaders: Record<string, string> = {
  // No Access-Control-Allow-Origin on purpose.
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-digest-token, x-ingest-token",
  "access-control-max-age": "86400",
  vary: "Origin",
};
