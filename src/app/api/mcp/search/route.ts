import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ count: 0, matches: [] }, { headers: corsHeaders });
  const needle = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  // SQLite ignores the `\%` / `\_` escapes above unless the LIKE carries an
  // ESCAPE clause, so wrap every LIKE with `ESCAPE '\'` (drizzle's like() emits none).
  const likeEsc = (col: Parameters<typeof like>[0]) => sql`${col} like ${needle} escape '\\'`;

  // ?repo=owner/name scopes results to matches whose project's githubFullName
  // matches — used by the MCP to default-filter when spawned in a specific repo.
  const repoFilter = url.searchParams.get("repo")?.trim().toLowerCase() || null;
  let scopedProjectIds: number[] | null = null;
  if (repoFilter) {
    const rows = await db
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, auth.userId),
        sql`LOWER(${schema.projectProfiles.githubFullName}) = ${repoFilter}`,
      ));
    scopedProjectIds = rows.map((r) => r.id);
    if (scopedProjectIds.length === 0) {
      return NextResponse.json(
        { q, count: 0, scopedTo: repoFilter, matches: [] },
        { headers: corsHeaders },
      );
    }
  }

  const matchConds = [
    eq(schema.matches.userId, auth.userId),
    or(
      likeEsc(schema.matches.summary),
      likeEsc(schema.matches.whyUseful),
      likeEsc(schema.matches.suggestedUse),
      likeEsc(schema.matches.writeupMd),
      likeEsc(schema.matches.personalNote),
      likeEsc(schema.repos.owner),
      likeEsc(schema.repos.name),
      likeEsc(schema.repos.description),
      sql`lower(${schema.repos.owner}) || '/' || lower(${schema.repos.name}) like ${needle.toLowerCase()} escape '\\'`,
    )!,
  ];
  if (scopedProjectIds) matchConds.push(inArray(schema.matches.projectId, scopedProjectIds));

  const rows = await db
    .select({ match: schema.matches, repo: schema.repos, project: schema.projectProfiles })
    .from(schema.matches)
    .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
    // leftJoin's ON clause carries the tenant guard so a future schema bug
    // (orphaned projectId pointing at another tenant) cannot leak rows.
    .leftJoin(schema.projectProfiles, and(
      eq(schema.matches.projectId, schema.projectProfiles.id),
      eq(schema.projectProfiles.userId, auth.userId),
    ))
    .where(and(...matchConds))
    .orderBy(desc(schema.matches.createdAt))
    .limit(50);

  const out = rows.map(({ match: m, repo: r, project: p }) => ({
    matchId: m.id,
    repo: `${r.owner}/${r.name}`,
    url: r.url,
    project: p?.slug ?? "_general",
    relevance: m.relevance,
    relevanceScore: m.relevanceScore,
    summary: ((m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "").slice(0, 400),
    starred: m.userStatus === "starred",
    bookmarked: m.userStatus === "bookmarked",
    handoffPrUrl: m.handoffPrUrl,
    createdAt: m.createdAt.toISOString(),
  }));
  const body: Record<string, unknown> = { q, count: out.length, matches: out };
  if (repoFilter) body.scopedTo = repoFilter;
  return NextResponse.json(body, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }
