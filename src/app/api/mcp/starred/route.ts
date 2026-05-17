import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  // Optional ?repo=owner/name scopes results to matches whose handoff target
  // is that repo (i.e., the matched project's github_full_name). Used by the
  // MCP to default-filter when spawned inside a specific repo. Case-insensitive
  // because GitHub URLs are.
  const url = new URL(req.url);
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
    // No project targets this repo → return empty cleanly (with a totalCount
    // hint below so the agent can fall back to repo='' if it wants).
    if (scopedProjectIds.length === 0) {
      // Still compute totalCount across all the user's starred/bookmarked rows
      // so the agent can tell the user "you have N saved elsewhere — pass
      // repo='' to see them" rather than reporting an absolute zero.
      const total = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(schema.matches)
        .where(and(
          eq(schema.matches.userId, auth.userId),
          or(eq(schema.matches.userStatus, "starred"), eq(schema.matches.userStatus, "bookmarked")),
        ))
        .get();
      return NextResponse.json(
        { count: 0, totalCount: Number(total?.c ?? 0), scopedTo: repoFilter, matches: [] },
        { headers: corsHeaders },
      );
    }
  }

  // 'starred' = action item; 'bookmarked' = save-for-later. Both flavours
  // surface in this endpoint so an agent calling /mcp/starred sees the full
  // saved-set; consumers that care about the split can read the `kind` field.
  const conds = [
    eq(schema.matches.userId, auth.userId),
    or(
      eq(schema.matches.userStatus, "starred"),
      eq(schema.matches.userStatus, "bookmarked"),
    )!,
  ];
  if (scopedProjectIds) conds.push(inArray(schema.matches.projectId, scopedProjectIds));
  const matches = await db
    .select()
    .from(schema.matches)
    .where(and(...conds))
    .orderBy(desc(schema.matches.createdAt));

  const repoIds = [...new Set(matches.map((m) => m.repoId))];
  const projectIds = [...new Set(matches.map((m) => m.projectId).filter((x): x is number => !!x))];
  const repoMap = new Map<number, typeof schema.repos.$inferSelect>();
  if (repoIds.length) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repoMap.set(r.id, r);
  }
  const projectMap = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (projectIds.length) {
    const ps = await db.select().from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, auth.userId),
        inArray(schema.projectProfiles.id, projectIds),
      ));
    for (const p of ps) projectMap.set(p.id, p);
  }

  const out = matches.map((m) => {
    const r = repoMap.get(m.repoId);
    const p = m.projectId ? projectMap.get(m.projectId) : null;
    const bucket = m.integratedAt || m.handoffPrStatus === "merged" ? "integrated"
      : m.handoffPrUrl ? "open-pr"
      : "awaiting";
    return {
      matchId: m.id,
      repo: r ? `${r.owner}/${r.name}` : null,
      url: r?.url ?? null,
      project: p?.slug ?? "_general",
      bucket,
      kind: m.userStatus === "bookmarked" ? "bookmark" : "star",
      handoffPrUrl: m.handoffPrUrl,
      handoffPrStatus: m.handoffPrStatus,
      relevance: m.relevance,
      summary: ((m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "").slice(0, 400),
    };
  });
  const body: Record<string, unknown> = { count: out.length, matches: out };
  if (repoFilter) body.scopedTo = repoFilter;
  return NextResponse.json(body, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }
