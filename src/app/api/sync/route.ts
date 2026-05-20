import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";

// GET /api/sync?since=<iso8601>
// Token-protected (keyed on SYNC_TOKEN so the laptop CLI works without Firebase).
// SYNC_TOKEN is bound to exactly one user via the SYNC_USER_ID env var. The
// user-id is no longer accepted from the query string — it would have been a
// 403-vs-200 fingerprint of the valid id, and accepting it tempted future
// maintainers to "support multiple users" with a single token.
export async function GET(req: Request) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const userId = Number(process.env.SYNC_USER_ID);
  if (!Number.isFinite(userId)) {
    console.error("[/api/sync] SYNC_USER_ID env var not set or not numeric — refusing");
    return new NextResponse("server misconfigured", { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const sinceParam = searchParams.get("since");
  // Default: last 7 days. Cap the floor at 90 days so a leaked token can't
  // request the entire history in one shot.
  const MAX_SINCE_MS = 90 * 24 * 3600 * 1000;
  const floor = new Date(Date.now() - MAX_SINCE_MS);
  const requested = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const since = requested < floor ? floor : requested;

  const matches = await db
    .select()
    .from(schema.matches)
    .where(
      and(
        eq(schema.matches.userId, userId),
        gte(schema.matches.createdAt, since),
        isNotNull(schema.matches.writeupMd)
      )
    )
    .orderBy(desc(schema.matches.createdAt));

  type Out = { slug: string; writeups: { id: number; repo: string; createdAt: string; markdown: string }[] };
  const byProject = new Map<string, Out>();
  for (const m of matches) {
    const r = await db.select().from(schema.repos).where(eq(schema.repos.id, m.repoId)).get();
    if (!r) continue;
    const slug = m.projectId
      ? (await db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, m.projectId)).get())?.slug ?? "_general"
      : "_general";
    if (!byProject.has(slug)) byProject.set(slug, { slug, writeups: [] });
    byProject.get(slug)!.writeups.push({
      id: m.id,
      repo: `${r.owner}__${r.name}`,
      createdAt: m.createdAt.toISOString(),
      markdown: m.writeupMd ?? "",
    });
  }

  return NextResponse.json({ since: since.toISOString(), projects: [...byProject.values()] });
}

function authorized(req: Request): boolean {
  const token = process.env.SYNC_TOKEN;
  // Fail closed: previously this returned true when SYNC_TOKEN was unset,
  // exposing every user's matches to the open internet given a guessable user_id.
  if (!token) {
    console.error("[/api/sync] SYNC_TOKEN env var not set - refusing all requests");
    return false;
  }
  const got = req.headers.get("x-sync-token");
  if (!got) return false;
  // Constant-time compare so attackers can't time-slice the secret.
  return timingSafeEqualStr(got, token);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
