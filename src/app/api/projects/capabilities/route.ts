import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { capabilitiesFromDeps, mergeCapabilityTags } from "@/projects/capabilities";
import { parseTechSummaryDeps } from "@/fetchers/stack-watch/registry";
import { facetInputsFor, embedFacets } from "@/projects/facets";
import { serialiseFacetEmbeddings } from "@/lib/embeddings";
import { PROMPT_VERSION, type ProjectSummary } from "@/projects/summarize";

// Phase 6 — in-session capability extraction. The onboarding skill reads the
// open codebase and pushes the project's technical capabilities here, instead
// of waiting for the server-side Stage-1 LLM to infer them on the next cron run.
// We merge in the deterministic dep→capability tags, store them on the project,
// and build the facet vectors IMMEDIATELY (OpenAI embeddings only — no LLM), so
// matching works the moment onboarding finishes. Zero server LLM cost for a new
// project.
//
// Body: { repo?: "owner/name", repoId?: number, capabilities: string[] }
//
// Project resolution is owner-tolerant (exact github_full_name, then repo name).

type Body = { repo?: string; repoId?: number; capabilities?: unknown };

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }
  if (!Array.isArray(body.capabilities)) {
    return NextResponse.json({ error: "capabilities must be an array of strings" }, { status: 400, headers: corsHeaders });
  }
  const agentCaps = body.capabilities.filter((c): c is string => typeof c === "string");

  // Resolve the project (owner-tolerant), scoped to this user.
  let project: typeof schema.projectProfiles.$inferSelect | null = null;
  if (typeof body.repoId === "number") {
    project = await db.select().from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.id, body.repoId), eq(schema.projectProfiles.userId, auth.userId))).get() ?? null;
  } else if (typeof body.repo === "string" && /^[^/]+\/[^/]+$/.test(body.repo)) {
    const repoFilter = body.repo.trim().toLowerCase();
    project = await db.select().from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, auth.userId), sql`LOWER(${schema.projectProfiles.githubFullName}) = ${repoFilter}`)).get() ?? null;
    if (!project) {
      const namePart = repoFilter.slice(repoFilter.indexOf("/") + 1);
      const byName = await db.select().from(schema.projectProfiles)
        .where(and(eq(schema.projectProfiles.userId, auth.userId),
          sql`LOWER(substr(${schema.projectProfiles.githubFullName}, instr(${schema.projectProfiles.githubFullName}, '/') + 1)) = ${namePart}`));
      byName.sort((a, b) =>
        (Number(!!(b.active && b.included)) - Number(!!(a.active && a.included))) ||
        ((b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)));
      project = byName[0] ?? null;
    }
  } else {
    return NextResponse.json({ error: "must specify repo ('owner/name') or repoId" }, { status: 400, headers: corsHeaders });
  }
  if (!project) {
    return NextResponse.json(
      { error: "project not found — register it first (npx replen sync-projects, or add it on /projects)" },
      { status: 404, headers: corsHeaders },
    );
  }

  // Merge agent capabilities with the deterministic dep→capability tags.
  const merged = mergeCapabilityTags(agentCaps, capabilitiesFromDeps(parseTechSummaryDeps(project.techSummary)));
  if (merged.length === 0) {
    return NextResponse.json({ error: "no usable capabilities after cleaning" }, { status: 400, headers: corsHeaders });
  }

  // Store capabilities on the project's summary (preserve an existing summary's
  // other fields; create a minimal one for a fresh project). Marking it fresh
  // (hash = current profile hash, current prompt version) means the cron LLM
  // won't re-infer capabilities until the docs change — the in-session caps are
  // authoritative. That's the zero-LLM-onboarding contract.
  let summary: ProjectSummary | null = null;
  if (project.summaryJson) {
    try { summary = JSON.parse(project.summaryJson) as ProjectSummary; } catch { summary = null; }
  }
  if (!summary) {
    summary = {
      purpose: "", keyCapabilities: [], capabilityTags: [], currentTech: {},
      outcomeGoals: [], crossRepoDependencies: [],
      languageSignals: { hardConstraints: [], detected: [] },
      generatedAt: new Date().toISOString(), sourceFiles: [], llmModel: "in-session", promptVersion: PROMPT_VERSION,
    };
  }
  summary.capabilityTags = merged;

  // Build facet vectors now (capabilities + any doc sections). Embeddings only.
  const { hash, inputs } = facetInputsFor({ capabilityTags: merged, readmeMd: project.readmeMd, claudeMd: project.claudeMd });
  const facets = inputs.length > 0 ? await embedFacets(inputs) : [];

  await db.update(schema.projectProfiles).set({
    summaryJson: JSON.stringify(summary),
    summaryHash: project.profileHash,
    summaryGeneratedAt: new Date(),
    summaryPromptVersion: PROMPT_VERSION,
    facetEmbeddings: facets.length > 0 ? serialiseFacetEmbeddings({ hash, facets }) : project.facetEmbeddings,
    updatedAt: new Date(),
  }).where(eq(schema.projectProfiles.id, project.id));

  return NextResponse.json(
    { ok: true, project: project.slug, capabilities: merged, facetsBuilt: facets.length },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
