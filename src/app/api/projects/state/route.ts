import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { needsReground, summaryIsGrounded } from "@/projects/summarize";

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

  // Optional cwd-repo drift inputs from the local MCP server: `repo` (owner/name)
  // + `head` (git HEAD). When present, the matching project also gets a code-DRIFT
  // reground check; every project gets the (head-independent) schema-staleness
  // check regardless. Lets a background re-ground backfill mechanism/maturity into
  // repos grounded before those fields, and refresh the cwd repo when code moved.
  const url = new URL(req.url);
  const scopeRepo = url.searchParams.get("repo")?.trim().toLowerCase() || null;
  const headParam = url.searchParams.get("head")?.trim().toLowerCase();
  const localHead = headParam && /^[0-9a-f]{7,64}$/.test(headParam) ? headParam : null;
  const throttleHours = Math.max(0, parseInt(process.env.REPLEN_REGROUND_THROTTLE_HOURS ?? "24", 10) || 24);
  // Account opt-out: when auto-grounding is off, never emit needsReground.
  const autoground = auth.settings.autogroundEnabled !== false;

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
      summaryJson: schema.projectProfiles.summaryJson,
    })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, auth.userId));

  const projects = rows.map((r) => {
    const grounded = summaryIsGrounded(r.summaryJson ?? null);
    // Drift check gets the live HEAD only for the repo the MCP is scoped to.
    const isScoped = scopeRepo != null && r.githubFullName != null && r.githubFullName.toLowerCase() === scopeRepo;
    const rg = grounded && autoground
      ? needsReground({ summaryJson: r.summaryJson ?? null, localHead: isScoped ? localHead : null, throttleHours })
      : { reground: false, reason: !grounded ? "not-grounded" : "opted-out" };
    return {
      slug: r.slug,
      repo: r.githubFullName,
      active: !!r.active,
      included: !!r.included,
      profileHash: r.profileHash,
      hasCapabilities: r.facetEmbeddings != null,
      hasReport: r.agentReport != null,
      hasVersions: r.depVersions != null,
      grounded,
      needsReground: rg.reground,
      regroundReason: rg.reason,
    };
  });

  return NextResponse.json({ projects, autoground }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
