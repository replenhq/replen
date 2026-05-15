import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";

// GET /api/sync?since=<iso8601>&user_id=<id>
// Token-protected (still keyed on SYNC_TOKEN so the laptop CLI works without Firebase).
// Always scoped to a specific user_id — required.
export async function GET(req: Request) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const userIdParam = searchParams.get("user_id");
  if (!userIdParam) return new NextResponse("user_id required", { status: 400 });
  const userId = Number(userIdParam);
  if (!Number.isFinite(userId)) return new NextResponse("user_id must be a number", { status: 400 });

  const sinceParam = searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 7 * 24 * 3600 * 1000);

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
    console.error("[/api/sync] SYNC_TOKEN env var not set — refusing all requests");
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
