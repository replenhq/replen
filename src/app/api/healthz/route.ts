import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { sql } from "drizzle-orm";

// Liveness + readiness probe for uptime monitors (UptimeRobot,
// BetterStack, Cloudflare Health Checks) and on-host healthchecks.
// Public, no auth — only returns a tiny JSON body and a status code.
//
// Returns 200 if the process is up AND a trivial SQLite query
// succeeds (db file is mounted, the user table is readable). Returns
// 503 if the db is unreachable; that's the signal external monitors
// should alert on. Both responses cache-bust the way Cloudflare
// expects (no edge caching of monitor responses).
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    // Cheap query; the row count is incidental, what matters is that
    // the db responds.
    const row = await db.select({ c: sql<number>`count(*)` }).from(schema.users).get();
    const dbMs = Date.now() - startedAt;
    return NextResponse.json(
      { ok: true, db: "ok", users: Number(row?.c ?? 0), dbMs, at: new Date().toISOString() },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, db: "error", error: e instanceof Error ? e.message : String(e), at: new Date().toISOString() },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
