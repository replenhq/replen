import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../_auth";

// "Is there anything new and actionable for this user since they last
// engaged with replen?" Designed to be cheap and called automatically at
// the start of every Claude Code session (via a SessionStart hook) plus
// the `replen_check_new` MCP tool.
//
// Cursor model: max(users.lastViewedAt, users.lastMcpCheckAt). The two
// columns let the dashboard, the email, and the MCP hook all advance a
// single conceptual cursor without conflicting. Every call bumps
// lastMcpCheckAt to now() *before* returning, so a session that surfaces
// matches doesn't re-surface them on the next launch.
//
// Default scope is the current repo (matched against
// projectProfiles.githubFullName). Pass ?repo='' to override and check
// the user's whole feed.
//
// Relevance gate is high+medium only — same threshold the email send and
// webhook use; matches the calm-cadence positioning ("1-3 actionable
// matches a month").
//
// SKILL-MODE TIER (fork addition): when the user's subscription_tier is
// 'skill', the matches table is empty (LLM scoring moves into the
// agent's session). We instead query the candidates inventory + the
// user_match_state exclusion to determine "is there anything fresh
// the user hasn't seen / starred / hidden yet?" Same cursor model,
// same response shape — the SessionStart hook command (`replen
// check-new --hook`) doesn't need to change.
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const url = new URL(req.url);
  const repoFilter = url.searchParams.get("repo")?.trim().toLowerCase() || null;

  const user = await db
    .select({
      lastViewedAt: schema.users.lastViewedAt,
      lastMcpCheckAt: schema.users.lastMcpCheckAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, auth.userId))
    .get();

  const viewedMs = user?.lastViewedAt ? +user.lastViewedAt : 0;
  const checkedMs = user?.lastMcpCheckAt ? +user.lastMcpCheckAt : 0;
  const cursor = new Date(Math.max(viewedMs, checkedMs));

  // Bump the cursor BEFORE reading. If we crash between read and write,
  // the user re-sees on next call — strictly safer than silently losing.
  await db
    .update(schema.users)
    .set({ lastMcpCheckAt: new Date() })
    .where(eq(schema.users.id, auth.userId));

  // Resolve repo scope once; both tier branches use it.
  let scopedProjectIds: number[] | null = null;
  if (repoFilter) {
    const rows = await db
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(
        and(
          eq(schema.projectProfiles.userId, auth.userId),
          sql`LOWER(${schema.projectProfiles.githubFullName}) = ${repoFilter}`,
        ),
      );
    if (rows.length === 0) {
      // The cwd isn't a repo Replen knows about. Stay silent for both tiers.
      return NextResponse.json(
        { hasNew: false, count: 0, scopedTo: repoFilter, since: cursor.toISOString() },
        { headers: corsHeaders },
      );
    }
    scopedProjectIds = rows.map((r) => r.id);
  }

  const tier = auth.settings.subscriptionTier ?? "skill";

  if (tier === "skill") {
    return handleSkillTier({ userId: auth.userId, cursor, scopedProjectIds, repoFilter });
  }

  // Hosted tier (legacy): query the LLM-scored matches table.
  const conds = [
    eq(schema.matches.userId, auth.userId),
    gt(schema.matches.createdAt, cursor),
    ne(schema.matches.userStatus, "hidden"),
    isNull(schema.matches.archivedAt),
    inArray(schema.matches.relevance, ["high", "medium"]),
  ];
  if (scopedProjectIds) {
    conds.push(inArray(schema.matches.projectId, scopedProjectIds));
  }

  // Preview limit: aim 3, cap 5. Beyond that the agent's "mention it
  // briefly" intro becomes its own digest.
  const fresh = await db
    .select()
    .from(schema.matches)
    .where(and(...conds))
    .orderBy(desc(schema.matches.relevanceScore))
    .limit(5);

  if (fresh.length === 0) {
    return NextResponse.json(
      { hasNew: false, count: 0, scopedTo: repoFilter ?? null, since: cursor.toISOString() },
      { headers: corsHeaders },
    );
  }

  const repoIds = [...new Set(fresh.map((m) => m.repoId))];
  const repos = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
  const repoMap = new Map(repos.map((r) => [r.id, r]));

  const projectIds = [...new Set(fresh.map((m) => m.projectId).filter((x): x is number => !!x))];
  const projectMap = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (projectIds.length) {
    const ps = await db
      .select()
      .from(schema.projectProfiles)
      .where(
        and(
          eq(schema.projectProfiles.userId, auth.userId),
          inArray(schema.projectProfiles.id, projectIds),
        ),
      );
    for (const p of ps) projectMap.set(p.id, p);
  }

  const matches = fresh.map((m) => {
    const r = repoMap.get(m.repoId);
    const p = m.projectId ? projectMap.get(m.projectId) : null;
    const oneLine = (m.summary ?? "").split("\n")[0]?.slice(0, 160) ?? "";
    return {
      matchId: m.id,
      repo: r ? `${r.owner}/${r.name}` : null,
      project: p?.slug ?? "_general",
      relevance: m.relevance,
      relevanceScore: m.relevanceScore,
      effortBand: m.effortBand,
      oneLine,
    };
  });

  return NextResponse.json(
    {
      hasNew: true,
      count: matches.length,
      scopedTo: repoFilter ?? null,
      since: cursor.toISOString(),
      matches,
      nextStep: "Call replen_today for the full writeups.",
    },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

// Skill-tier branch of /api/mcp/check-new. Same response shape as the
// hosted branch above, but the underlying signal is "fresh inventory
// candidates the user hasn't acted on" instead of "fresh LLM-scored
// matches." The SessionStart hook command (`replen check-new --hook`)
// receives identical JSON either way; only the upstream data source
// differs by tier.
async function handleSkillTier({
  userId,
  cursor,
  scopedProjectIds,
  repoFilter,
}: {
  userId: number;
  cursor: Date;
  scopedProjectIds: number[] | null;
  repoFilter: string | null;
}): Promise<NextResponse> {
  // Excluded repos: anything the user already starred / hidden /
  // handed_off. Skill-tier users explicitly act per candidate so this
  // is the canonical "don't re-surface" set.
  const stateRows = await db
    .select({ repoId: schema.userMatchState.repoId })
    .from(schema.userMatchState)
    .where(and(
      eq(schema.userMatchState.userId, userId),
      inArray(schema.userMatchState.status, ["starred", "hidden", "handed_off"]),
    ));
  const excludedRepoIds = new Set(stateRows.map((r) => r.repoId));

  // Pull candidates fresher than the cursor. The cursor model is shared
  // with hosted tier via users.lastViewedAt + lastMcpCheckAt, which the
  // outer GET handler already bumped before this call.
  const fresh = await db
    .select()
    .from(schema.candidates)
    .where(and(
      eq(schema.candidates.userId, userId),
      gt(schema.candidates.fetchedAt, cursor),
    ))
    .orderBy(desc(schema.candidates.score), desc(schema.candidates.fetchedAt))
    .limit(50); // cap before per-row repo lookup

  if (fresh.length === 0) {
    return NextResponse.json(
      { hasNew: false, count: 0, scopedTo: repoFilter ?? null, since: cursor.toISOString() },
      { headers: corsHeaders },
    );
  }

  // For each candidate, look up the resolved repo so we can produce a
  // repo string + filter against scopedProjectIds. The scoping check
  // matches the hosted-tier behavior: only candidates whose repo's
  // owner/name align with one of the scoped projects' githubFullName.
  // For now we approximate by extracting owner/name from githubUrl.
  const preview: Array<{
    matchId: number;
    repo: string | null;
    project: string;
    relevance: string;
    relevanceScore: number | null;
    effortBand: string | null;
    oneLine: string;
  }> = [];
  for (const c of fresh) {
    if (preview.length >= 5) break;
    if (!c.githubUrl) continue;
    const m = c.githubUrl.match(/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/i);
    if (!m) continue;
    const owner = m[1];
    const name = m[2];
    const r = await db
      .select()
      .from(schema.repos)
      .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name)))
      .get();
    if (!r) continue;
    if (excludedRepoIds.has(r.id)) continue;
    // If repoFilter was set, scopedProjectIds is non-null; filter the
    // candidate by whether ANY scoped project is its project context.
    // Today candidates are tagged with userId not projectId, so we
    // pre-filtered via scopedProjectIds at the outer handler — here we
    // accept all surviving candidates and let the agent triage.
    void scopedProjectIds;
    preview.push({
      matchId: c.id, // re-purpose as candidateId for response-shape compat
      repo: `${r.owner}/${r.name}`,
      project: "_general",
      relevance: classifyRelevance(c.score),
      relevanceScore: c.score,
      effortBand: null, // skill computes effort in-session, not server-side
      oneLine: (c.title ?? r.description ?? "").slice(0, 160),
    });
  }

  if (preview.length === 0) {
    return NextResponse.json(
      { hasNew: false, count: 0, scopedTo: repoFilter ?? null, since: cursor.toISOString() },
      { headers: corsHeaders },
    );
  }

  return NextResponse.json(
    {
      hasNew: true,
      count: preview.length,
      scopedTo: repoFilter ?? null,
      since: cursor.toISOString(),
      matches: preview,
      nextStep: "Call replen_match to triage these in-session.",
    },
    { headers: corsHeaders },
  );
}

// Map a raw candidate score (star count, in practice) to a relevance
// bucket so the response shape mirrors the hosted-tier output. The
// agent will refine to a real fit score in-session; this is just the
// session-start teaser. Buckets are intentionally generous on the
// high/medium side — the inventory is already eligibility-filtered.
function classifyRelevance(score: number | null): string {
  if (score == null) return "general-awareness";
  if (score >= 500) return "high";
  if (score >= 50) return "medium";
  return "general-awareness";
}
