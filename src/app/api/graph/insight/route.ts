import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { resolveOrCreateRepoId } from "@/lib/resolve-repo";
import { allowAction, WRITE_LIMIT, WRITE_WINDOW_MS } from "@/lib/rate-limit";

// Atlas — capture a Pass 3/4 portfolio insight from the multi-vector triage:
// a 'lesson' (a transferable idea / premise / way-of-working) or a 'boundary'
// (something we're now explicitly NOT), recorded EVEN WHEN the prompting
// candidate is a direct-use skip — the Graphify→Atlas lane. Distinct from
// /api/triage (a per-candidate use-verdict): an insight is a portfolio
// decision. The graph build (src/graph/build.ts) reads triage_insights into
// lesson/boundary nodes — INSIGHT_FOR edge to the project they touch, plus a
// FROM_CANDIDATE provenance edge to the repo that prompted them — so they
// appear in the Atlas graph.
//   POST { kind: 'lesson'|'boundary', text, viaCandidate?: "owner/name", project?: slug }
const VALID_KINDS = new Set(["lesson", "boundary"]);
const MAX_TEXT = 2000;

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  if (!allowAction(`writes:${auth.userId}`, WRITE_LIMIT, WRITE_WINDOW_MS)) {
    return NextResponse.json({ error: "rate limit exceeded, slow down" }, { status: 429, headers: corsHeaders });
  }

  let body: { kind?: string; text?: string; viaCandidate?: string; project?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const kind = String(body.kind ?? "");
  const text = String(body.text ?? "").trim();
  if (!VALID_KINDS.has(kind)) {
    return NextResponse.json({ error: "kind must be 'lesson' or 'boundary'" }, { status: 400, headers: corsHeaders });
  }
  if (text.length < 3) {
    return NextResponse.json({ error: "text required" }, { status: 400, headers: corsHeaders });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: `text too long (max ${MAX_TEXT})` }, { status: 400, headers: corsHeaders });
  }

  // The candidate that prompted the insight (owner/name) → repoId. Optional —
  // an insight can be portfolio-wide with no single prompting repo.
  let viaCandidateRepoId: number | null = null;
  if (typeof body.viaCandidate === "string" && body.viaCandidate.includes("/")) {
    const [owner, name] = body.viaCandidate.split("/");
    if (owner && name) {
      try { viaCandidateRepoId = await resolveOrCreateRepoId(owner, name); } catch { viaCandidateRepoId = null; }
    }
  }

  // The project this insight touches (slug, scoped to the user). Optional.
  let appliesToProjectId: number | null = null;
  if (typeof body.project === "string" && body.project) {
    const p = await db
      .select({ id: schema.projectProfiles.id })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, auth.userId), eq(schema.projectProfiles.slug, body.project)))
      .get();
    appliesToProjectId = p?.id ?? null;
  }

  const inserted = await db
    .insert(schema.triageInsights)
    .values({ userId: auth.userId, kind, text, viaCandidateRepoId, appliesToProjectId, createdAt: new Date() })
    .returning({ id: schema.triageInsights.id });

  return NextResponse.json({ ok: true, id: inserted[0]?.id ?? null, kind }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
