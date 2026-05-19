// Top-level orchestrator for Initiative #3 (synthesis across matches).
// Runs after runPruneSuggestions in the pipeline. Per run:
//   1. Load all matches created in this run (scouted + discovered +
//      re-checked + prune).
//   2. Cluster them programmatically (synthesis-cluster.ts).
//   3. For each cluster, call the LLM synthesiser (one call per cluster)
//      and persist the result as a match_insights row.
//   4. Skip clusters whose evidence is already covered by an unread /
//      starred insight from a previous run this week (cheap dedup).

import { db, schema } from "../db/client";
import { and, eq, gt, gte, inArray, ne, isNull } from "drizzle-orm";
import { recordEvent } from "../scheduler/events";
import { findClusters, type Cluster } from "./synthesis-cluster";
import { synthesiseInsight, type SynthesisMatch, type SynthesisProjectContext } from "./synthesise-insight";
import { LlmQuotaError } from "../analyzer/llm";
import { resolveClusterProvider } from "../lib/llm-routing";
import type { ProjectSummary } from "./summarize";
import type { ProjectActivitySummary } from "./activity-summary";

// Synthesis looks across the last N days of matches, not just this run's
// matches. A single pipeline run typically produces 1-6 matches, which is
// below the clustering floor — but a week's worth (~15-30) reliably forms
// real clusters. The 7-day window matches the dedup window so the same
// cluster doesn't get re-shipped day-after-day. Insights still get tagged
// with the CURRENT run id so the feed can scope by "this week" the same
// way it scopes matches.
const SYNTHESIS_LOOKBACK_DAYS = 7;

export async function runSynthesis(runId: number, userId: number): Promise<{ insightsCreated: number }> {
  // Pull recent matches (last 7 days). We don't restrict by relevance
  // tier; even general-awareness matches can be evidence for a topic
  // insight ("you keep seeing X this week, the pattern is Y"). Hidden /
  // archived matches are excluded so the user's "hide" signal also
  // suppresses them as evidence — synthesising over things the user
  // already dismissed would be noise.
  const since = new Date(Date.now() - SYNTHESIS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const matchRows = await db
    .select({
      id: schema.matches.id,
      repoOwner: schema.repos.owner,
      repoName: schema.repos.name,
      repoUrl: schema.repos.url,
      projectId: schema.matches.projectId,
      relevance: schema.matches.relevance,
      relevanceScore: schema.matches.relevanceScore,
      summary: schema.matches.summary,
      whyUseful: schema.matches.whyUseful,
      suggestedUse: schema.matches.suggestedUse,
      integrationApproach: schema.matches.integrationApproach,
      matchedOutcome: schema.matches.matchedOutcome,
      discoveryMode: schema.matches.discoveryMode,
      prunedDepEcosystem: schema.matches.prunedDepEcosystem,
    })
    .from(schema.matches)
    .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
    .where(and(
      eq(schema.matches.userId, userId),
      gte(schema.matches.createdAt, since),
      ne(schema.matches.userStatus, "hidden"),
      isNull(schema.matches.archivedAt),
    ));

  if (matchRows.length < 3) {
    // Clustering only fires at ≥3 (topic / approach) or ≥2 projects
    // (cross-project). Below that there's nothing to synthesise.
    return { insightsCreated: 0 };
  }

  // Build project slug map for ALL the user's projects so the
  // clustering layer can resolve projectId → slug. We also load summary
  // + activity so we can hand the LLM project context per cluster.
  const projects = await db
    .select({
      id: schema.projectProfiles.id,
      slug: schema.projectProfiles.slug,
      name: schema.projectProfiles.name,
      sensitivity: schema.projectProfiles.sensitivity,
      llmProvider: schema.projectProfiles.llmProvider,
      summaryJson: schema.projectProfiles.summaryJson,
      activityJson: schema.projectProfiles.activityJson,
    })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));

  const projectSlugById = new Map<number, string>();
  const projectBySlug = new Map<number | string, typeof projects[0]>();
  for (const p of projects) {
    projectSlugById.set(p.id, p.slug);
    projectBySlug.set(p.slug, p);
  }

  // Adapt matches to the shape the clustering layer expects.
  const clusters = findClusters(
    matchRows.map((m) => ({
      id: m.id,
      summary: m.summary,
      whyUseful: m.whyUseful,
      suggestedUse: m.suggestedUse,
      integrationApproach: m.integrationApproach,
      projectId: m.projectId,
      prunedDepEcosystem: m.prunedDepEcosystem,
      matchedOutcome: m.matchedOutcome,
    })),
    projectSlugById,
  );

  if (clusters.length === 0) {
    void recordEvent(runId, userId, "scan", "Synthesis: no clusters above thresholds, skipping");
    return { insightsCreated: 0 };
  }

  void recordEvent(runId, userId, "score", `Synthesis: ${clusters.length} cluster(s) identified, drafting`);

  // Dedup against unread / starred insights from the last 7 days. If an
  // earlier run already shipped an insight covering essentially the same
  // match set, don't reship a near-duplicate.
  const recentSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recent = await db
    .select({
      evidenceMatchIds: schema.matchInsights.evidenceMatchIds,
      kind: schema.matchInsights.kind,
    })
    .from(schema.matchInsights)
    .where(and(
      eq(schema.matchInsights.userId, userId),
      gt(schema.matchInsights.createdAt, recentSince),
      ne(schema.matchInsights.userStatus, "hidden"),
    ));
  const recentSigs = new Set<string>();
  for (const r of recent) {
    try {
      const ids = JSON.parse(r.evidenceMatchIds) as number[];
      recentSigs.add(sigFor(r.kind, ids));
    } catch { /* ignore corrupt */ }
  }

  // Index matchRows by id for quick lookup when building per-cluster
  // SynthesisMatch payloads.
  const matchById = new Map(matchRows.map((m) => [m.id, m]));

  let insightsCreated = 0;
  for (const cluster of clusters) {
    const sig = sigFor(cluster.kind, cluster.matchIds);
    if (recentSigs.has(sig)) {
      void recordEvent(runId, userId, "scan", `Synthesis: skipping duplicate ${cluster.kind} insight (same evidence as recent insight)`);
      continue;
    }

    // Build the SynthesisMatch list, ordered by relevanceScore desc so
    // the LLM sees the strongest evidence first.
    const synthMatches: SynthesisMatch[] = [];
    for (const id of cluster.matchIds) {
      const m = matchById.get(id);
      if (!m) continue;
      synthMatches.push({
        id: m.id,
        repoFullName: `${m.repoOwner}/${m.repoName}`,
        repoUrl: m.repoUrl ?? null,
        projectSlug: m.projectId ? projectSlugById.get(m.projectId) ?? null : null,
        relevance: m.relevance,
        relevanceScore: m.relevanceScore ?? 0,
        summary: m.summary,
        whyUseful: m.whyUseful,
        suggestedUse: m.suggestedUse,
        integrationApproach: m.integrationApproach,
        matchedOutcome: m.matchedOutcome,
        discoveryMode: m.discoveryMode,
      });
    }
    synthMatches.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));

    // Collect project contexts + routing inputs for projects in this
    // cluster. The provider decision honors per-project llmProvider
    // overrides (a user can opt sensitive projects into DeepSeek
    // without an Anthropic key) — see src/lib/llm-routing.ts.
    const slugsInCluster = new Set(synthMatches.map((m) => m.projectSlug).filter((s): s is string => !!s));
    const projectContexts: SynthesisProjectContext[] = [];
    const routingInputs: { sensitivity?: string | null; llmProvider?: string | null }[] = [];
    for (const slug of slugsInCluster) {
      const p = projectBySlug.get(slug);
      if (!p) continue;
      routingInputs.push({ sensitivity: p.sensitivity, llmProvider: p.llmProvider });
      const ctx = buildProjectContext(p);
      if (ctx) projectContexts.push(ctx);
    }
    const clusterProvider = resolveClusterProvider(routingInputs);

    let result;
    try {
      result = await synthesiseInsight({
        cluster,
        matches: synthMatches,
        projects: projectContexts,
        provider: clusterProvider,
      });
    } catch (e) {
      if (e instanceof LlmQuotaError) throw e;
      console.warn(`[synth] cluster kind=${cluster.kind} failed:`, e);
      continue;
    }
    if (!result) continue;

    await db.insert(schema.matchInsights).values({
      userId,
      runId,
      kind: cluster.kind,
      title: result.title,
      bodyMd: result.bodyMd,
      evidenceMatchIds: JSON.stringify(cluster.matchIds),
      primaryProjectSlug: cluster.primaryProjectSlug,
      themes: result.themes.length > 0 ? JSON.stringify(result.themes) : null,
      userStatus: "unread",
      createdAt: new Date(),
    });
    insightsCreated++;
    void recordEvent(
      runId,
      userId,
      "match",
      `Synthesis: "${result.title.slice(0, 80)}" (${cluster.kind} · ${cluster.matchIds.length} matches)`,
    );

    // Surface the new insight in the same per-run dedup set so a
    // second cluster with the same evidence in this run is skipped.
    recentSigs.add(sig);
  }

  if (insightsCreated > 0) {
    void recordEvent(runId, userId, "score", `Synthesis: ${insightsCreated} insight(s) added`);
  }
  return { insightsCreated };
}

function buildProjectContext(p: {
  slug: string;
  name: string;
  summaryJson: string | null;
  activityJson: string | null;
}): SynthesisProjectContext | null {
  let purpose: string | null = null;
  if (p.summaryJson) {
    try {
      const s = JSON.parse(p.summaryJson) as ProjectSummary;
      purpose = s.purpose ?? null;
    } catch { /* ignore */ }
  }
  let currentlyBuilding: string | null = null;
  if (p.activityJson) {
    try {
      const a = JSON.parse(p.activityJson) as ProjectActivitySummary;
      if (a.state === "active" && a.summary) currentlyBuilding = a.summary;
    } catch { /* ignore */ }
  }
  return { slug: p.slug, name: p.name, purpose, currentlyBuilding };
}

// Cluster dedup signature: kind + sorted match-id set. Two clusters with
// the same kind and same evidence collapse, regardless of order.
function sigFor(kind: string, matchIds: number[]): string {
  return `${kind}:${[...matchIds].sort((a, b) => a - b).join(",")}`;
}

// Helper for the migration/backfill case where someone wants to re-run
// synthesis for an existing run. Not used by the live pipeline.
export async function deleteSynthesisForRun(runId: number, userId: number): Promise<number> {
  const existing = await db
    .select({ id: schema.matchInsights.id })
    .from(schema.matchInsights)
    .where(and(
      eq(schema.matchInsights.userId, userId),
      eq(schema.matchInsights.runId, runId),
    ));
  if (existing.length === 0) return 0;
  await db
    .delete(schema.matchInsights)
    .where(and(
      eq(schema.matchInsights.userId, userId),
      inArray(schema.matchInsights.id, existing.map((r) => r.id)),
    ));
  return existing.length;
}
