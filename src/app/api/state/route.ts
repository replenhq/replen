import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../mcp/_auth";

// Skill-mode state endpoint. The skill posts user-action state here
// when the user stars / hides / opens a handoff PR. This is the ONLY
// place user-action signal lands server-side — all the LLM scoring +
// writeup happens in-session and never persists.
//
// Body shape:
//   { repoId: number, projectId?: number | null, status: "starred" | "hidden" | "handed_off" | "surfaced",
//     handoffPrUrl?: string, userNote?: string }
//
// Or by owner/name:
//   { repo: "owner/name", projectId?: number | null, status: ... }
//
// Behaviour: upsert on (user_id, repo_id, project_id). Idempotent —
// repeating the same action just bumps action_at.
//
// 'surfaced' is the optional explicit "the agent showed this to me"
// marker; useful for the inventory to know what to deprioritize on the
// next call (rather than re-surfacing the same N repos every session
// until the user acts). Skill calls this for each repo it actually
// presents in a writeup.

type StateBody = {
  repoId?: number;
  repo?: string;
  projectId?: number | null;
  status?: "starred" | "hidden" | "handed_off" | "surfaced";
  handoffPrUrl?: string;
  userNote?: string;
};

const VALID_STATUSES = ["starred", "hidden", "handed_off", "surfaced"] as const;

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }

  let body: StateBody;
  try {
    body = (await req.json()) as StateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  if (!body.status || !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400, headers: corsHeaders },
    );
  }

  // Resolve repo by id or owner/name. Per-user state is keyed by
  // global repo_id, not candidate_id, because the same repo can be
  // surfaced via different sources and we want one canonical state row.
  let repoId: number | null = null;
  if (typeof body.repoId === "number") {
    const r = await db.select().from(schema.repos).where(eq(schema.repos.id, body.repoId)).get();
    if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404, headers: corsHeaders });
    repoId = r.id;
  } else if (typeof body.repo === "string" && /^[^/]+\/[^/]+$/.test(body.repo)) {
    const [owner, name] = body.repo.split("/");
    const r = await db
      .select()
      .from(schema.repos)
      .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name)))
      .get();
    if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404, headers: corsHeaders });
    repoId = r.id;
  } else {
    return NextResponse.json(
      { error: "must specify repoId (number) or repo ('owner/name')" },
      { status: 400, headers: corsHeaders },
    );
  }

  // Validate optional projectId belongs to this user (defence in depth —
  // forging a foreign projectId would otherwise let an attacker write
  // their state under another tenant's project).
  let projectId: number | null = null;
  if (body.projectId != null) {
    const p = await db
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.id, body.projectId), eq(schema.projectProfiles.userId, auth.userId)))
      .get();
    if (!p) {
      return NextResponse.json({ error: "project not found for this user" }, { status: 404, headers: corsHeaders });
    }
    projectId = p.id;
  }

  const now = new Date();

  // Upsert on (user_id, repo_id, project_id). SQLite's INSERT ... ON
  // CONFLICT lets us bump action_at and update the status atomically.
  // surfacedAt only sets on initial insert (the first time we ever
  // saw this combo). Drizzle's onConflictDoUpdate is the idiomatic API.
  const existing = await db
    .select()
    .from(schema.userMatchState)
    .where(and(
      eq(schema.userMatchState.userId, auth.userId),
      eq(schema.userMatchState.repoId, repoId!),
      // Treat projectId=null and projectId=number as distinct rows.
      projectId === null
        ? sql`${schema.userMatchState.projectId} IS NULL`
        : eq(schema.userMatchState.projectId, projectId),
    ))
    .get();

  const isSurfaced = body.status === "surfaced";
  if (existing) {
    await db
      .update(schema.userMatchState)
      .set({
        status: body.status,
        // 'surfaced' is a re-show, not a user action: bump the surfacing
        // recency + count (drives the cool-off window) and leave actionAt
        // untouched. Terminal statuses (star/hide/handoff) stamp actionAt.
        ...(isSurfaced
          ? {
              surfacedAt: now,
              surfacedCount: sql`${schema.userMatchState.surfacedCount} + 1`,
            }
          : { actionAt: now }),
        ...(body.handoffPrUrl !== undefined ? { handoffPrUrl: body.handoffPrUrl } : {}),
        ...(body.userNote !== undefined ? { userNote: body.userNote } : {}),
      })
      .where(eq(schema.userMatchState.id, existing.id));
  } else {
    await db.insert(schema.userMatchState).values({
      userId: auth.userId,
      repoId: repoId!,
      projectId,
      status: body.status,
      surfacedAt: now,
      surfacedCount: isSurfaced ? 1 : 0,
      actionAt: isSurfaced ? null : now,
      handoffPrUrl: body.handoffPrUrl ?? null,
      userNote: body.userNote ?? null,
    });
  }

  return NextResponse.json({ ok: true, repoId, projectId, status: body.status }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
