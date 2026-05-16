import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, gte, sql } from "drizzle-orm";
import { hashIngestToken } from "@/lib/crypto";

// Rate limit: how many manual ingests a single user may make in a sliding
// hour window. Higher than realistic human use; trips only on token misuse
// or a runaway bookmarklet.
const MAX_INGESTS_PER_HOUR = 50;
// Hard cap on outstanding manual candidates not yet swept by the pipeline.
// Stops a leaked token from flooding the analysis queue.
const MAX_PENDING_MANUAL = 200;

// POST /api/ingest
//   headers: x-ingest-token: <user's personal ingest token from /settings>
//   body:    { url: "https://github.com/owner/repo", title?: "...", note?: "..." }
//
// Creates a candidate scoped to the token's owner so the next pipeline run
// picks it up. Useful from a bookmarklet or browser extension - the user
// finds an interesting repo on the web, hits the bookmark, it lands in their
// digest queue.
//
// Auth: per-user opaque token (not Firebase). The session auth is too messy
// for cross-origin bookmarklets. Token is created on /settings and can be
// rotated.
export async function POST(req: Request) {
  // Both header names accepted for symmetry with /api/mcp/*. Canonical:
  // x-ingest-token. x-digest-token kept for back-compat with older MCP
  // clients that used "digest" naming. SECURITY.md notes the asymmetry.
  const token = req.headers.get("x-ingest-token") ?? req.headers.get("x-digest-token");
  if (!token) return NextResponse.json({ ok: false, error: "missing x-ingest-token" }, { status: 401 });

  const row = await db
    .select({ settings: schema.userSettings, status: schema.users.status })
    .from(schema.userSettings)
    .innerJoin(schema.users, eq(schema.users.id, schema.userSettings.userId))
    .where(eq(schema.userSettings.ingestTokenHash, hashIngestToken(token)))
    .get();
  if (!row) return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  // Suspended or pending users keep the token bytes, but the surface goes dark.
  if (row.status !== "active") return NextResponse.json({ ok: false, error: "account inactive" }, { status: 403 });
  const settings = row.settings;

  // Sliding-hour rate limit + outstanding-cap. Without this a leaked token
  // could flood the queue with score=100 candidates and burn through LLM
  // budget on the next pipeline tick.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const hourCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.candidates)
    .where(
      and(
        eq(schema.candidates.userId, settings.userId),
        eq(schema.candidates.source, "manual"),
        gte(schema.candidates.fetchedAt, hourAgo)
      )
    )
    .get();
  if ((hourCount?.n ?? 0) >= MAX_INGESTS_PER_HOUR) {
    return NextResponse.json(
      { ok: false, error: `rate limit: max ${MAX_INGESTS_PER_HOUR} ingests/hour` },
      { status: 429 }
    );
  }
  const pendingCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.candidates)
    .where(
      and(
        eq(schema.candidates.userId, settings.userId),
        eq(schema.candidates.source, "manual")
      )
    )
    .get();
  if ((pendingCount?.n ?? 0) >= MAX_PENDING_MANUAL) {
    return NextResponse.json(
      { ok: false, error: `queue full: ${MAX_PENDING_MANUAL} manual candidates outstanding; wait for the next pipeline run` },
      { status: 429 }
    );
  }

  let body: { url?: string; title?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!url) return NextResponse.json({ ok: false, error: "url required" }, { status: 400 });

  // Extract owner/name if it's a github URL; otherwise store as a plain
  // candidate with the URL as-is. The pipeline only analyses candidates with
  // a populated github_url, so non-GH URLs are filed but harmless.
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  const githubUrl = m ? `https://github.com/${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
  const sourceItemId = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  // Dedupe by user + github URL (or raw URL) so a double-click doesn't queue
  // the same repo twice.
  if (githubUrl) {
    const existing = await db
      .select({ id: schema.candidates.id })
      .from(schema.candidates)
      .where(and(eq(schema.candidates.userId, settings.userId), eq(schema.candidates.githubUrl, githubUrl)))
      .get();
    if (existing) return NextResponse.json({ ok: true, deduped: true, candidateId: existing.id });
  }

  const inserted = await db
    .insert(schema.candidates)
    .values({
      userId: settings.userId,
      source: "manual",
      sourceItemId,
      title: body.title ?? null,
      url,
      githubUrl,
      author: body.note ?? null,
      score: 100, // manual ingest is high signal - surface it first
      postedAt: new Date(),
      fetchedAt: new Date(),
      rawJson: null,
    })
    .returning()
    .get();

  return NextResponse.json({ ok: true, candidateId: inserted.id, githubUrl });
}

// Bookmarklet + MCP both POST server-to-server (browser bookmarklet runs in
// a privileged context that bypasses CORS for its own fetch). We don't need
// `Access-Control-Allow-Origin: *` and not setting it tightens the blast
// radius if a token ever leaks: a browser cross-origin POST will fail at
// the preflight rather than reach this endpoint with a stolen token.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-ingest-token, x-digest-token",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}
