import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ count: 0, matches: [] }, { headers: corsHeaders });
  const needle = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;

  const rows = await db
    .select({ match: schema.matches, repo: schema.repos, project: schema.projectProfiles })
    .from(schema.matches)
    .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
    .leftJoin(schema.projectProfiles, eq(schema.matches.projectId, schema.projectProfiles.id))
    .where(and(
      eq(schema.matches.userId, auth.userId),
      or(
        like(schema.matches.summary, needle),
        like(schema.matches.whyUseful, needle),
        like(schema.matches.suggestedUse, needle),
        like(schema.matches.writeupMd, needle),
        like(schema.matches.personalNote, needle),
        like(schema.repos.owner, needle),
        like(schema.repos.name, needle),
        like(schema.repos.description, needle),
        sql`lower(${schema.repos.owner}) || '/' || lower(${schema.repos.name}) like ${needle.toLowerCase()}`,
      ),
    ))
    .orderBy(desc(schema.matches.createdAt))
    .limit(50);

  const out = rows.map(({ match: m, repo: r, project: p }) => ({
    matchId: m.id,
    repo: `${r.owner}/${r.name}`,
    url: r.url,
    project: p?.slug ?? "_general",
    relevance: m.relevance,
    relevanceScore: m.relevanceScore,
    summary: ((m.writeupMd ?? "").split("\n\n— — —\n")[0]?.trim() || m.summary || "").slice(0, 400),
    starred: m.userStatus === "starred",
    handoffPrUrl: m.handoffPrUrl,
    createdAt: m.createdAt.toISOString(),
  }));
  return NextResponse.json({ q, count: out.length, matches: out }, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }
