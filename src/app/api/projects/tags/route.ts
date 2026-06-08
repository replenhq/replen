import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";

// Set the domain tags on one of the user's registered Replen projects.
//
// Exists so the /replen-match onboarding flow can write the tags the agent
// INFERRED from the code (e.g. "crypto, trading, market-making, ccxt") instead
// of telling the user to set them by hand on the web — the friction that made
// onboarding sticky. Tags sharpen matching (filter-mode pre-filter + signal for
// a freshly-registered project that has no embedding yet).
//
// Body: { repo?: "owner/name", repoId?: number, tags: string[] }
//
// Project resolution is owner-tolerant: exact github_full_name first, then by
// repo NAME alone (a repo that moved orgs still resolves), preferring an
// active+included row.

type Body = { repo?: string; repoId?: number; tags?: unknown };

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  if (!Array.isArray(body.tags)) {
    return NextResponse.json({ error: "tags must be an array of strings" }, { status: 400, headers: corsHeaders });
  }
  const tags = Array.from(
    new Set(
      body.tags
        .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ).slice(0, 30);

  // Resolve the project (owner-tolerant), scoped to this user.
  let project: typeof schema.projectProfiles.$inferSelect | null = null;
  if (typeof body.repoId === "number") {
    project = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.id, body.repoId), eq(schema.projectProfiles.userId, auth.userId)))
      .get() ?? null;
  } else if (typeof body.repo === "string" && /^[^/]+\/[^/]+$/.test(body.repo)) {
    const repoFilter = body.repo.trim().toLowerCase();
    project = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, auth.userId),
        sql`LOWER(${schema.projectProfiles.githubFullName}) = ${repoFilter}`,
      ))
      .get() ?? null;
    if (!project) {
      const namePart = repoFilter.slice(repoFilter.indexOf("/") + 1);
      const byName = await db
        .select()
        .from(schema.projectProfiles)
        .where(and(
          eq(schema.projectProfiles.userId, auth.userId),
          sql`LOWER(substr(${schema.projectProfiles.githubFullName}, instr(${schema.projectProfiles.githubFullName}, '/') + 1)) = ${namePart}`,
        ));
      byName.sort((a, b) =>
        (Number(!!(b.active && b.included)) - Number(!!(a.active && a.included))) ||
        ((b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)),
      );
      project = byName[0] ?? null;
    }
  } else {
    return NextResponse.json(
      { error: "must specify repo ('owner/name') or repoId" },
      { status: 400, headers: corsHeaders },
    );
  }

  if (!project) {
    return NextResponse.json(
      { error: "project not found — register it first (npx replen sync-projects, or add it on /projects)" },
      { status: 404, headers: corsHeaders },
    );
  }

  await db
    .update(schema.projectProfiles)
    .set({ tags: tags.length > 0 ? JSON.stringify(tags) : null, updatedAt: new Date() })
    .where(eq(schema.projectProfiles.id, project.id));

  return NextResponse.json(
    { ok: true, project: project.slug, githubFullName: project.githubFullName, tags },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
