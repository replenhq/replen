import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { hashIngestToken } from "@/lib/crypto";

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
  const settings = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.ingestTokenHash, hash))
    .get();
  if (!settings) return null;
  return { userId: settings.userId, settings };
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
