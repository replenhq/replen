import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";

// Per-repo onboarding state — the cheap pre-flight for /replen-onboard. The
// orchestrator reads this ONCE before grounding so it can do the minimum work
// per repo instead of re-reading every codebase on every run:
//   - not listed / !hasCapabilities → full ground (read code, derive caps, report)
//   - hasCapabilities && !hasVersions → lightweight version-only backfill
//   - hasCapabilities && hasVersions && hasReport → skip (already grounded)
// This is what turns a 24-minute re-run into ~2 minutes. Names + booleans only,
// never code or report contents.
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const rows = await db
    .select({
      slug: schema.projectProfiles.slug,
      githubFullName: schema.projectProfiles.githubFullName,
      active: schema.projectProfiles.active,
      included: schema.projectProfiles.included,
      profileHash: schema.projectProfiles.profileHash,
      facetEmbeddings: schema.projectProfiles.facetEmbeddings,
      agentReport: schema.projectProfiles.agentReport,
      depVersions: schema.projectProfiles.depVersions,
    })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, auth.userId));

  const projects = rows.map((r) => ({
    slug: r.slug,
    repo: r.githubFullName,
    active: !!r.active,
    included: !!r.included,
    profileHash: r.profileHash,
    hasCapabilities: r.facetEmbeddings != null,
    hasReport: r.agentReport != null,
    hasVersions: r.depVersions != null,
  }));

  return NextResponse.json({ projects }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
