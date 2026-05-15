import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { hashIngestToken } from "@/lib/crypto";

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
  const token = req.headers.get("x-ingest-token");
  if (!token) return NextResponse.json({ ok: false, error: "missing x-ingest-token" }, { status: 401 });

  const settings = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.ingestTokenHash, hashIngestToken(token)))
    .get();
  if (!settings) return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });

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

// Permissive CORS so a bookmarklet on any origin can POST.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-ingest-token",
      "access-control-max-age": "86400",
    },
  });
}
