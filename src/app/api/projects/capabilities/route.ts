import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { capabilitiesFromDeps, mergeCapabilityTags } from "@/projects/capabilities";
import { parseTechSummaryDeps } from "@/fetchers/stack-watch/registry";
import { facetInputsFor, embedFacets } from "@/projects/facets";
import { serialiseFacetEmbeddings } from "@/lib/embeddings";
import { PROMPT_VERSION, reconcileCapabilities, type ProjectSummary } from "@/projects/summarize";
import { coerceModalities, inferCapabilityModality, type CapabilitySpec } from "@/projects/modality";

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

type Body = { repo?: string; repoId?: number; capabilities?: unknown; report?: unknown; purpose?: unknown; goals?: unknown; mode?: unknown };

// Cap the stored report so a runaway agent can't write megabytes.
const MAX_REPORT_CHARS = 24_000;

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
    return NextResponse.json({ error: "capabilities must be an array (of strings, or {tag, descriptor, modality} objects)" }, { status: 400, headers: corsHeaders });
  }
  // Accept BOTH the grounded form ({tag, descriptor, modality}) and the legacy
  // bare-string form. Grounded specs carry the disambiguating descriptor +
  // modality the matcher needs; bare strings get an inferred modality.
  const agentSpecs: CapabilitySpec[] = [];
  const agentTags: string[] = [];
  for (const c of body.capabilities) {
    // Everything the agent sends is GROUNDED — it read the actual source.
    if (typeof c === "string") {
      const tag = c.trim();
      if (tag) { agentTags.push(tag); agentSpecs.push({ tag, descriptor: "", modality: inferCapabilityModality(tag), provenance: "grounded" }); }
    } else if (c && typeof c === "object" && typeof (c as Record<string, unknown>).tag === "string") {
      const cc = c as Record<string, unknown>;
      const tag = (cc.tag as string).trim();
      if (!tag) continue;
      const descriptor = typeof cc.descriptor === "string" ? cc.descriptor.trim() : "";
      const modality = coerceModalities(cc.modality);
      // Evidence anchors: file PATHS implementing this capability (≤5, paths
      // only — never code). They flow into the graph + leaps + dossier.
      const paths = Array.isArray(cc.paths)
        ? (cc.paths as unknown[])
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim().replace(/^\/+/, "").slice(0, 200))
            .filter(Boolean)
            .slice(0, 5)
        : undefined;
      agentTags.push(tag);
      agentSpecs.push({ tag, descriptor, modality: modality.length ? modality : inferCapabilityModality(tag, descriptor), provenance: "grounded", paths: paths?.length ? paths : undefined });
    }
  }

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

  // mode=merge (triage write-back): start from the project's EXISTING grounded
  // capabilities and add/augment, so a partial call (e.g. one capability + its
  // file paths discovered during triage) never wipes the rest. Paths from the
  // incoming specs are unioned onto matching tags; new tags are appended.
  // mode=replace (default, onboarding's full set): unchanged.
  const mode = body.mode === "merge" ? "merge" : "replace";
  let baseTags = agentTags;
  let baseSpecs = agentSpecs;
  if (mode === "merge") {
    let prev: ProjectSummary | null = null;
    try { prev = project.summaryJson ? (JSON.parse(project.summaryJson) as ProjectSummary) : null; } catch { prev = null; }
    const prevTags = Array.isArray(prev?.capabilityTags) ? prev!.capabilityTags.filter((t): t is string => typeof t === "string") : [];
    const prevSpecs = Array.isArray(prev?.capabilities) ? (prev!.capabilities as CapabilitySpec[]) : [];
    const normTag = (t: string) => t.trim().toLowerCase();
    const byTag = new Map<string, CapabilitySpec>();
    for (const s of prevSpecs) if (s?.tag) byTag.set(normTag(s.tag), { ...s });
    for (const s of agentSpecs) {
      const k = normTag(s.tag); const ex = byTag.get(k);
      if (!ex) { byTag.set(k, s); continue; }
      const paths = Array.from(new Set([...(ex.paths ?? []), ...(s.paths ?? [])])).slice(0, 5);
      byTag.set(k, {
        tag: ex.tag,
        descriptor: ex.descriptor || s.descriptor,
        modality: ex.modality?.length ? ex.modality : s.modality,
        provenance: "grounded",
        paths: paths.length ? paths : undefined,
      });
    }
    baseSpecs = [...byTag.values()];
    baseTags = Array.from(new Set([...prevTags, ...agentTags]));
  }

  // Merge agent capabilities with the deterministic dep→capability tags, then
  // reconcile grounded specs so every final tag has a descriptor + modality.
  const merged = mergeCapabilityTags(baseTags, capabilitiesFromDeps(parseTechSummaryDeps(project.techSummary)));
  if (merged.length === 0) {
    return NextResponse.json({ error: "no usable capabilities after cleaning" }, { status: 400, headers: corsHeaders });
  }
  const mergedSpecs = reconcileCapabilities(merged, baseSpecs);

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
      purpose: "", keyCapabilities: [], capabilityTags: [], capabilities: [], currentTech: {},
      outcomeGoals: [], crossRepoDependencies: [],
      languageSignals: { hardConstraints: [], detected: [] },
      generatedAt: new Date().toISOString(), sourceFiles: [], llmModel: "in-session", promptVersion: PROMPT_VERSION,
    };
  }
  summary.capabilityTags = merged;
  summary.capabilities = mergedSpecs;
  // Product THESIS — what the project is trying to BE and where it's heading.
  // Distinct from capabilities (what it technically does): the thesis is the
  // mission a candidate should ADVANCE, and the relevance test the in-session
  // agent triages against ("does this serve a contested-airspace decision-
  // support platform?" >> "does this do OSINT?"). Derived by the agent from the
  // code + any goals.md/handover.md/roadmap the user already keeps. Names/intent
  // only — never sensitive operational detail (respect the cover).
  if (typeof body.purpose === "string" && body.purpose.trim()) {
    summary.purpose = body.purpose.trim().slice(0, 600);
  }
  if (Array.isArray(body.goals)) {
    // Agent-supplied goals are user/doc-grounded directions → stored as
    // high-confidence "user" OutcomeGoals (same shape the server summarizer uses,
    // so Stage-2 goal-aware ranking treats them as first-class).
    summary.outcomeGoals = body.goals
      .filter((g): g is string => typeof g === "string" && !!g.trim())
      .slice(0, 8)
      .map((g) => ({ statement: g.trim().slice(0, 200), source: "user" as const, confidence: "high" as const }));
  }

  // The agent's grounded project report (optional) — stored as an additional
  // grounding input for the server's safety-net summarization on the next regen.
  const agentReport = typeof body.report === "string" && body.report.trim()
    ? body.report.trim().slice(0, MAX_REPORT_CHARS)
    : project.agentReport;

  // Build facet vectors now (grounded capabilities + any doc sections). Embeddings only.
  // The stored domain cloud anchors each facet in the project's field (Step 1).
  let domainTags: string[] = [];
  if (project.tags) {
    try { const a = JSON.parse(project.tags); if (Array.isArray(a)) domainTags = a.filter((t): t is string => typeof t === "string"); } catch { /* no domain qualifier */ }
  }
  const { hash, inputs } = facetInputsFor({ capabilities: mergedSpecs, capabilityTags: merged, keyCapabilities: summary?.keyCapabilities, readmeMd: project.readmeMd, claudeMd: project.claudeMd, projectName: project.name ?? project.slug, projectSlug: project.slug, purpose: summary?.purpose, domainTags });
  const facets = inputs.length > 0 ? await embedFacets(inputs) : [];

  await db.update(schema.projectProfiles).set({
    summaryJson: JSON.stringify(summary),
    summaryHash: project.profileHash,
    summaryGeneratedAt: new Date(),
    summaryPromptVersion: PROMPT_VERSION,
    agentReport,
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
