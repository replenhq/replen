import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";

// Token auth shared by every /api/mcp/* endpoint. The MCP server passes the
// user's personal token in either header — `x-digest-token` is preferred,
// `x-ingest-token` accepted for symmetry with /api/ingest (same token).
export type McpAuth = {
  userId: number;
  settings: typeof schema.userSettings.$inferSelect;
};

export async function authenticate(req: Request): Promise<McpAuth | null> {
  const token = req.headers.get("x-digest-token") ?? req.headers.get("x-ingest-token");
  if (!token) return null;
  const settings = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.ingestToken, token))
    .get();
  if (!settings) return null;
  return { userId: settings.userId, settings };
}

// MCP servers run on the user's machine and POST cross-origin. The token in
// the header is the authentication boundary; CORS is permissive on purpose.
export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-digest-token, x-ingest-token",
  "access-control-max-age": "86400",
};
