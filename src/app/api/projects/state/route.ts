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
      nudgedAt: schema.projectProfiles.nudgedAt,
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
      nudgedAt: r.nudgedAt ? r.nudgedAt.toISOString() : null,
    };
  });

  // Owner-matched auto-register (ACTIVATION). If the cwd repo the MCP is scoped
  // to is a REAL repo (owner/name), not already registered, and its owner matches
  // one the user already has projects under, register its identity NOW. That turns
  // "no entry, stay silent" into "registered, hasCapabilities:false" so the agent
  // grounds it silently this session and matching works next session. The
  // owner-match guard is what stops a repo the user is merely BROWSING (a clone of
  // someone else's project) from silently joining their portfolio.
  let justRegistered: string | null = null;
  const isRealRepo = scopeRepo != null && /^[^/\s]+\/[^/\s]+$/.test(scopeRepo);
  const alreadyRegistered = scopeRepo != null && rows.some((r) => (r.githubFullName ?? "").toLowerCase() === scopeRepo);
  if (isRealRepo && !alreadyRegistered && autoground) {
    const owner = scopeRepo!.split("/")[0];
    const allowedOwners = new Set(rows.map((r) => (r.githubFullName ?? "").toLowerCase().split("/")[0]).filter(Boolean));
    if (allowedOwners.has(owner)) {
      const name = scopeRepo!.split("/")[1];
      const existingSlugs = new Set(rows.map((r) => r.slug));
      const base = name.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || owner;
      const slug = existingSlugs.has(base) ? `${base}-${owner}`.replace(/[^a-z0-9_-]/g, "-").slice(0, 80) : base;
      try {
        await db.insert(schema.projectProfiles).values({
          userId: auth.userId,
          slug,
          path: `github:${scopeRepo}`,
          name,
          githubFullName: scopeRepo!,
          profileHash: "pending-loader",
          active: true,
          included: true,
          sensitivity: "low",
          llmProvider: "auto",
          updatedAt: new Date(),
        });
        justRegistered = scopeRepo;
        projects.push({
          slug,
          repo: scopeRepo,
          active: true,
          included: true,
          profileHash: "pending-loader",
          hasCapabilities: false,
          hasReport: false,
          hasVersions: false,
          grounded: false,
          needsReground: false,
          regroundReason: "not-grounded",
          nudgedAt: null,
        });
      } catch {
        // Unique-constraint race (a concurrent session registered it) or slug
        // collision: treat as already registered, nothing to do.
      }
    }
  }

  return NextResponse.json({ projects, autoground, justRegistered }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
