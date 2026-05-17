import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "2", 10) || 2, 1), 30);
  const relevance = (url.searchParams.get("relevance") ?? "high,medium").split(",").filter(Boolean);
  const projectSlug = url.searchParams.get("project");

  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const conds = [
    eq(schema.matches.userId, auth.userId),
    gte(schema.matches.createdAt, since),
    ne(schema.matches.userStatus, "hidden"),
    isNull(schema.matches.archivedAt),
    inArray(schema.matches.relevance, relevance),
  ];
  if (projectSlug) {
    const p = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, auth.userId), eq(schema.projectProfiles.slug, projectSlug)))
      .get();
    if (p) conds.push(eq(schema.matches.projectId, p.id));
  }

  const matches = await db.select().from(schema.matches).where(and(...conds)).orderBy(desc(schema.matches.relevanceScore)).limit(50);
  const repoIds = [...new Set(matches.map((m) => m.repoId))];
  const projectIds = [...new Set(matches.map((m) => m.projectId).filter((x): x is number => !!x))];
  const repoMap = new Map<number, typeof schema.repos.$inferSelect>();
  if (repoIds.length) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repoMap.set(r.id, r);
  }
  const projectMap = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (projectIds.length) {
    // Defence in depth: the projectIds come from this user's own matches so
    // they are already tenant-scoped, but the redundant userId filter ensures
    // a future bug that leaks a foreign id into the array cannot return
    // another tenant's profile data.
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
    const writeup = (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
    return {
      matchId: m.id,
      repo: r ? `${r.owner}/${r.name}` : null,
      url: r?.url ?? null,
      project: p?.slug ?? "_general",
      relevance: m.relevance,
      relevanceScore: m.relevanceScore,
      stars: r?.stars ?? null,
      language: r?.primaryLanguage ?? null,
      license: r?.license ?? null,
      summary: writeup,
      sourceKind: m.sourceKind,
      starred: m.userStatus === "starred",
      bookmarked: m.userStatus === "bookmarked",
      handoffPrUrl: m.handoffPrUrl,
      createdAt: m.createdAt.toISOString(),
    };
  });
  return NextResponse.json({ days, count: out.length, matches: out }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
