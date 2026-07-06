import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../mcp/_auth";
import { resolveOrCreateRepoId } from "@/lib/resolve-repo";
import { allowAction, WRITE_LIMIT, WRITE_WINDOW_MS } from "@/lib/rate-limit";

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
  if (!allowAction(`writes:${auth.userId}`, WRITE_LIMIT, WRITE_WINDOW_MS)) {
    return NextResponse.json({ error: "rate limit exceeded, slow down" }, { status: 429, headers: corsHeaders });
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

  // Length / charset caps on the free-text + URL fields. These land in the
  // GLOBAL repos table and are rendered back into the user's agent + dashboard
  // (handoffPrUrl becomes a clickable href), so reject anything that isn't a
  // GitHub-shaped owner/name, an https URL, or a bounded note.
  if (body.repo !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(body.repo)) {
    return NextResponse.json({ error: "repo must be 'owner/name' with GitHub-valid characters" }, { status: 400, headers: corsHeaders });
  }
  if (body.handoffPrUrl !== undefined &&
      (typeof body.handoffPrUrl !== "string" || body.handoffPrUrl.length > 500 || !/^https:\/\/[^\s]+$/i.test(body.handoffPrUrl))) {
    return NextResponse.json({ error: "handoffPrUrl must be an https URL (max 500 chars)" }, { status: 400, headers: corsHeaders });
  }
  if (body.userNote !== undefined && (typeof body.userNote !== "string" || body.userNote.length > 2000)) {
    return NextResponse.json({ error: "userNote must be a string (max 2000 chars)" }, { status: 400, headers: corsHeaders });
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
    // Resolve-or-create: star/hide on a catalogue candidate (repoId: null) must
    // persist a repo row, not 404. See src/lib/resolve-repo.ts.
    repoId = await resolveOrCreateRepoId(owner, name);
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

  // Atomic upsert — no select-then-insert race (two concurrent requests for the
  // same repo could otherwise both miss and both insert, minting duplicate
  // global rows). Global (null-project) rows conflict on the partial unique
  // index; scoped rows on the full (user, repo, project) index. surfacedAt only
  // sets on initial insert; a re-surface bumps recency + count; a terminal
  // action (star/hide/handoff) stamps actionAt.
  const isSurfaced = body.status === "surfaced";
  await db
    .insert(schema.userMatchState)
    .values({
      userId: auth.userId,
      repoId: repoId!,
      projectId,
      status: body.status,
      surfacedAt: now,
      surfacedCount: isSurfaced ? 1 : 0,
      actionAt: isSurfaced ? null : now,
      handoffPrUrl: body.handoffPrUrl ?? null,
      userNote: body.userNote ?? null,
    })
    .onConflictDoUpdate({
      target: projectId === null
        ? [schema.userMatchState.userId, schema.userMatchState.repoId]
        : [schema.userMatchState.userId, schema.userMatchState.repoId, schema.userMatchState.projectId],
      targetWhere: projectId === null ? sql`${schema.userMatchState.projectId} is null` : undefined,
      set: {
        status: body.status,
        ...(isSurfaced
          ? { surfacedAt: now, surfacedCount: sql`${schema.userMatchState.surfacedCount} + 1` }
          : { actionAt: now }),
        ...(body.handoffPrUrl !== undefined ? { handoffPrUrl: body.handoffPrUrl } : {}),
        ...(body.userNote !== undefined ? { userNote: body.userNote } : {}),
      },
    });

  return NextResponse.json({ ok: true, repoId, projectId, status: body.status }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
