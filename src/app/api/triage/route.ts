import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { authenticate, corsHeaders } from "../mcp/_auth";
import { recomputeRepoQuality } from "@/lib/repo-quality";
import { resolveOrCreateRepoId } from "@/lib/resolve-repo";

// Append-only triage-decision log. The /replen-match skill posts here
// after each per-candidate verdict so the Activity feed on / can show
// "Agent kept X for project Y · Mon 25 May". Distinct from /api/state:
//
//   /api/state     → user actions (star / hide / handoff). Monotonic
//                    per (user, repo, project). Updates a row.
//   /api/triage    → agent decisions (adopt / port / skip / defer).
//                    Append-only. Inserts a row.
//
// Body shape:
//   { repo: "owner/name",
//     project?: "slug" | null,
//     verdict: "adopt" | "port" | "skip" | "defer",
//     score?: number (0-100),
//     effortBand?: "quick" | "moderate" | "deep",
//     oneLine?: string,
//     writeup?: string,
//     sessionId?: string }
//
// projectId is resolved server-side from the project slug to defend
// against forged ids. sessionId is opaque to the server — used by the
// Activity feed to cluster events from the same Claude Code session.

type TriageBody = {
  repo?: string;
  repoId?: number;
  project?: string | null;
  projectId?: number | null;
  verdict?: string;
  score?: number;
  effortBand?: string;
  oneLine?: string;
  writeup?: string;
  sessionId?: string;
  // Contextual learning signal (L4): the capability facet this candidate matched,
  // its modality, and a structured reason for the verdict.
  matchedFacet?: string;
  facetModality?: string;
  reasonCode?: string;
};

const VALID_VERDICTS = ["adopt", "port", "skip", "defer"] as const;
const VALID_EFFORTS = ["quick", "moderate", "deep"] as const;
const VALID_REASONS = ["fit", "modality-collision", "task-collision", "covered", "wrong-posture", "low-quality", "other"] as const;

const MAX_WRITEUP_BYTES = 16 * 1024; // 16 KB ceiling; agents shouldn't dump megabytes.
const MAX_ONELINE_CHARS = 280;

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }

  let body: TriageBody;
  try {
    body = (await req.json()) as TriageBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  if (!body.verdict || !VALID_VERDICTS.includes(body.verdict as typeof VALID_VERDICTS[number])) {
    return NextResponse.json(
      { error: `verdict must be one of: ${VALID_VERDICTS.join(", ")}` },
      { status: 400, headers: corsHeaders },
    );
  }
  if (body.effortBand && !VALID_EFFORTS.includes(body.effortBand as typeof VALID_EFFORTS[number])) {
    return NextResponse.json(
      { error: `effortBand must be one of: ${VALID_EFFORTS.join(", ")}` },
      { status: 400, headers: corsHeaders },
    );
  }
  if (body.reasonCode && !VALID_REASONS.includes(body.reasonCode as typeof VALID_REASONS[number])) {
    return NextResponse.json(
      { error: `reasonCode must be one of: ${VALID_REASONS.join(", ")}` },
      { status: 400, headers: corsHeaders },
    );
  }
  if (typeof body.score === "number" && (body.score < 0 || body.score > 100)) {
    return NextResponse.json({ error: "score must be 0-100" }, { status: 400, headers: corsHeaders });
  }
  if (body.oneLine && body.oneLine.length > MAX_ONELINE_CHARS) {
    return NextResponse.json(
      { error: `oneLine exceeds ${MAX_ONELINE_CHARS} chars` },
      { status: 400, headers: corsHeaders },
    );
  }
  if (body.writeup && Buffer.byteLength(body.writeup, "utf8") > MAX_WRITEUP_BYTES) {
    return NextResponse.json(
      { error: `writeup exceeds ${MAX_WRITEUP_BYTES} bytes` },
      { status: 400, headers: corsHeaders },
    );
  }

  // Resolve repo by id or owner/name. Same pattern as /api/state.
  let repoId: number | null = null;
  if (typeof body.repoId === "number") {
    const r = await db.select().from(schema.repos).where(eq(schema.repos.id, body.repoId)).get();
    if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404, headers: corsHeaders });
    repoId = r.id;
  } else if (typeof body.repo === "string" && /^[^/]+\/[^/]+$/.test(body.repo)) {
    const [owner, name] = body.repo.split("/");
    // Resolve-or-create: most candidates are catalogue entries (repoId: null),
    // not persisted repo rows. See src/lib/resolve-repo.ts.
    repoId = await resolveOrCreateRepoId(owner, name);
  } else {
    return NextResponse.json(
      { error: "must specify repoId (number) or repo ('owner/name')" },
      { status: 400, headers: corsHeaders },
    );
  }

  // Resolve project by slug if given; defend against forged ids by
  // requiring the project belongs to the authed user.
  let projectId: number | null = null;
  if (typeof body.projectId === "number") {
    const p = await db
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.id, body.projectId), eq(schema.projectProfiles.userId, auth.userId)))
      .get();
    if (!p) return NextResponse.json({ error: "project not found for this user" }, { status: 404, headers: corsHeaders });
    projectId = p.id;
  } else if (typeof body.project === "string" && body.project.length > 0) {
    const p = await db
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.slug, body.project), eq(schema.projectProfiles.userId, auth.userId)))
      .get();
    if (!p) return NextResponse.json({ error: "project slug not found for this user" }, { status: 404, headers: corsHeaders });
    projectId = p.id;
  }

  const inserted = await db
    .insert(schema.triageEvents)
    .values({
      userId: auth.userId,
      repoId: repoId!,
      projectId,
      verdict: body.verdict,
      score: typeof body.score === "number" ? Math.round(body.score) : null,
      effortBand: body.effortBand ?? null,
      oneLine: body.oneLine ?? null,
      writeup: body.writeup ?? null,
      sessionId: body.sessionId ?? null,
      matchedFacet: typeof body.matchedFacet === "string" ? body.matchedFacet.slice(0, 120) : null,
      facetModality: typeof body.facetModality === "string" ? body.facetModality.slice(0, 120) : null,
      reasonCode: body.reasonCode ?? null,
      createdAt: new Date(),
    })
    .returning({ id: schema.triageEvents.id })
    .get();

  // Refresh the cross-user quality aggregate for this repo (L4 learning loop).
  // Best-effort: the triage is already durably recorded, so a recompute
  // failure must not fail the request — the next triage (or the backfill CLI)
  // will reconcile it.
  try {
    await recomputeRepoQuality(repoId!);
  } catch (e) {
    console.warn(`[triage] repo_quality recompute failed for repo ${repoId}:`, e);
  }

  return NextResponse.json(
    { ok: true, eventId: inserted?.id, repoId, projectId, verdict: body.verdict },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
