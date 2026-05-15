import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, inArray } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const matches = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, auth.userId), eq(schema.matches.userStatus, "starred")))
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
      handoffPrUrl: m.handoffPrUrl,
      handoffPrStatus: m.handoffPrStatus,
      relevance: m.relevance,
      summary: ((m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "").slice(0, 400),
    };
  });
  return NextResponse.json({ count: out.length, matches: out }, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }
