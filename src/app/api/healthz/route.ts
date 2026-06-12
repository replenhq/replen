import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { sql } from "drizzle-orm";
import { getEmbeddingHealth } from "@/lib/embeddings";

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
    // Cheap query; the result is discarded — what matters is that the
    // db responds. We deliberately don't surface the user count or any
    // other table contents in the response: a public probe shouldn't
    // double as a way for outsiders to track signup growth.
    await db.select({ c: sql<number>`count(*)` }).from(schema.users).get();
    const dbMs = Date.now() - startedAt;
    // Embedding health: surface a quota/billing outage loudly. The DB being up
    // doesn't mean the matcher is healthy — if embeddings are failing, new
    // candidates/facets silently stop getting vectors. We still return 200 (the
    // process IS live + serving), but flag `embeddings` so monitors/operators
    // can alert on a degraded-but-up state instead of discovering it weeks later.
    const emb = getEmbeddingHealth();
    const embedding = emb.ok
      ? { ok: true, lastSuccessAt: emb.lastSuccessAt }
      : { ok: false, quotaExhausted: emb.lastFailure?.quotaExhausted ?? false, since: emb.lastFailure?.at ?? null, message: emb.lastFailure?.message };
    return NextResponse.json(
      { ok: true, db: "ok", dbMs, embedding, at: new Date().toISOString() },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, db: "error", error: e instanceof Error ? e.message : String(e), at: new Date().toISOString() },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
