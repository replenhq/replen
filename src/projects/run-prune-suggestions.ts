// Top-level orchestrator for the prune flow (Initiative #2).
// Plugged into the pipeline after runAnalysis. Per active project:
//   1. Refresh manifest parse (cheap, ~5ms).
//   2. Refresh upstream-health probe if cache is older than 7 days.
//   3. For each stale/dead/archived dep, ask the LLM whether to drop /
//      replace / keep.
//   4. Insert matches with discoveryMode='prune', linking to a minimal
//      repos row for the targeted dep (created on demand).

import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { repoCiMatch } from "../lib/resolve-repo";
import { recordEvent } from "../scheduler/events";
import { parseManifests } from "./manifest-parser";
import { fetchFile, GitHubApiError } from "../github/repo-content";
import {
  probeDepHealth,
  mapWithConcurrency,
  PROBE_CONCURRENCY,
  needsHealthRefresh,
  type DepHealthCache,
  type UpstreamHealth,
  cacheKey,
} from "./dep-health";
import { suggestPrune, tierForVerdict, approachForVerdict, type PruneVerdict } from "./prune-suggester";
import { resolveProvider } from "../lib/llm-routing";
import type { ProjectActivitySummary } from "./activity-summary";
import type { ProjectSummary } from "./summarize";
import { LlmQuotaError } from "../analyzer/llm";

// Per-pipeline-run cap on how many LLM prune calls fire across all
// projects. Prevents a user with 30 projects from spending too much in a
// single run. Default 20; env-tunable for ops.
const MAX_LLM_CALLS_PER_RUN = parseInt(process.env.PRUNE_MAX_LLM_PER_RUN ?? "20", 10);

export async function runPruneSuggestions(runId: number, userId: number, ghToken: string | undefined): Promise<{ matchesCreated: number }> {
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      eq(schema.projectProfiles.included, true),
    ));
  if (projects.length === 0) return { matchesCreated: 0 };
  if (!ghToken) {
    // Prune needs to read user manifests via the GitHub API. No PAT
    // means we can't scan their deps. Don't fail the run — the rest
    // of the feed still works without prune signal.
    void recordEvent(runId, userId, "scan", "Prune skipped: no GitHub PAT on /settings");
    return { matchesCreated: 0 };
  }

  let llmCallsThisRun = 0;
  let totalMatches = 0;

  for (const p of projects) {
    if (llmCallsThisRun >= MAX_LLM_CALLS_PER_RUN) {
      void recordEvent(runId, userId, "scan", `Prune: hit per-run LLM cap (${MAX_LLM_CALLS_PER_RUN}); pausing for ${p.slug} and remainder`);
      break;
    }

    // Need a github_full_name to address the manifest via API.
    if (!p.githubFullName || !/^[\w.-]+\/[\w.-]+$/.test(p.githubFullName)) continue;
    const [pOwner, pName] = p.githubFullName.split("/");

    // Step 1: parse manifests from GitHub. Cheap (~5 API calls per
    // project, most return 404 quickly). The fetcher closure binds the
    // repo + token so parseManifests itself stays source-agnostic.
    let manifest;
    try {
      manifest = await parseManifests(async (filename) => {
        try { return await fetchFile(pOwner, pName, filename, ghToken); }
        catch (e) {
          if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) throw e;
          return null;
        }
      });
    } catch (e) {
      if (e instanceof GitHubApiError) {
        void recordEvent(runId, userId, "scan", `Prune: GitHub API ${e.status} fetching manifests for ${p.slug} — pausing`);
        break;
      }
      console.warn(`[prune] ${p.slug} manifest fetch failed:`, e);
      continue;
    }
    if (!manifest.hasManifest || manifest.deps.length === 0) {
      continue;
    }

    // Step 2: refresh health cache if stale (>7d) or missing.
    const refreshDecision = needsHealthRefresh({
      depHealthJson: p.depHealthJson ?? null,
      depHealthGeneratedAt: p.depHealthGeneratedAt ?? null,
    });

    let healthCache: DepHealthCache;
    if (refreshDecision.regen) {
      void recordEvent(runId, userId, "scan", `Refreshing dep health for ${p.slug} (${refreshDecision.reason}, ${manifest.deps.length} deps)`);
      const entries: Record<string, UpstreamHealth> = {};
      const healths = await mapWithConcurrency(manifest.deps, PROBE_CONCURRENCY, (d) => probeDepHealth(d));
      for (let i = 0; i < manifest.deps.length; i++) {
        const d = manifest.deps[i];
        entries[cacheKey(d.ecosystem, d.name)] = healths[i];
      }
      healthCache = { generatedAt: new Date().toISOString(), entries };
      await db
        .update(schema.projectProfiles)
        .set({
          depHealthJson: JSON.stringify(healthCache),
          depHealthGeneratedAt: new Date(),
        })
        .where(eq(schema.projectProfiles.id, p.id));
    } else {
      try {
        healthCache = JSON.parse(p.depHealthJson!) as DepHealthCache;
      } catch {
        // Corrupt cache. Skip this project this run; next run will refresh.
        console.warn(`[prune] ${p.slug}: corrupt dep_health_json, skipping`);
        continue;
      }
    }

    // Step 3: find deps that need an LLM verdict. Stale / dead / archived
    // are candidates. "unresolved" deps (no GH URL) we skip silently —
    // can't generate a useful prune writeup without upstream signal.
    const flagged: { dep: typeof manifest.deps[0]; health: UpstreamHealth }[] = [];
    for (const d of manifest.deps) {
      const h = healthCache.entries[cacheKey(d.ecosystem, d.name)];
      if (!h) continue;
      if (h.verdict === "stale" || h.verdict === "dead" || h.verdict === "archived") {
        flagged.push({ dep: d, health: h });
      }
    }
    if (flagged.length === 0) {
      continue;
    }

    // Skip if we already have an open (unread/starred/bookmarked) prune
    // match for this (project, dep) in the recent window. Avoids the
    // dashboard filling up with duplicates of the same advisory week
    // after week.
    const existingPruneMatches = await db
      .select({ depName: schema.matches.prunedDepName })
      .from(schema.matches)
      .where(and(
        eq(schema.matches.userId, userId),
        eq(schema.matches.projectId, p.id),
        eq(schema.matches.discoveryMode, "prune"),
      ));
    const existingDeps = new Set(existingPruneMatches.map((r) => r.depName).filter((x): x is string => !!x));

    // Parse the cached project summary + activity, to feed the LLM.
    let projectSummaryText: string | null = null;
    if (p.summaryJson) {
      try {
        const s = JSON.parse(p.summaryJson) as ProjectSummary;
        projectSummaryText = s.purpose ?? null;
      } catch { /* ignore */ }
    }
    let activitySummary: ProjectActivitySummary | null = null;
    if (p.activityJson) {
      try {
        activitySummary = JSON.parse(p.activityJson) as ProjectActivitySummary;
      } catch { /* ignore */ }
    }

    void recordEvent(runId, userId, "score", `Prune: ${flagged.length} stale dep(s) in ${p.slug}, scoring`);

    for (const { dep, health } of flagged) {
      if (llmCallsThisRun >= MAX_LLM_CALLS_PER_RUN) break;
      if (existingDeps.has(dep.name)) {
        // Already advised; skip silently. When the user actions the PR
        // or hides the match, they can be removed from the deduplication
        // set; that's a future-iteration polish.
        continue;
      }

      llmCallsThisRun++;
      let verdict: PruneVerdict | null;
      try {
        verdict = await suggestPrune({
          projectName: p.name,
          projectSlug: p.slug,
          projectSummary: projectSummaryText,
          activity: activitySummary,
          dep: { name: dep.name, version: dep.version, ecosystem: dep.ecosystem },
          health,
          provider: resolveProvider({ sensitivity: p.sensitivity, llmProvider: p.llmProvider }),
        });
      } catch (e) {
        if (e instanceof LlmQuotaError) throw e;
        console.warn(`[prune] ${p.slug}/${dep.name} failed:`, e);
        continue;
      }
      if (!verdict || verdict.action === "keep") {
        // "keep" verdicts don't surface; they're the LLM saying "this is
        // a false alarm". Future iteration could store these on a
        // separate table to avoid re-prompting for the same dep weekly.
        continue;
      }

      // Step 4: insert the match. We need a repoId, so ensure the
      // targeted dep's repo row exists (cheap upsert).
      if (!health.githubFullName) continue; // shouldn't happen — flagged deps all have GH URLs
      const [ghOwner, ghName] = health.githubFullName.split("/");
      const repoId = await ensureRepoRow(ghOwner, ghName, health);

      const writeupMd = verdict.writeup || verdict.summary || "(no writeup)";
      const tier = tierForVerdict(verdict);
      const approach = approachForVerdict(verdict);

      await db.insert(schema.matches).values({
        userId,
        repoId,
        projectId: p.id,
        runId,
        relevance: tier,
        relevanceScore: verdict.score,
        summary: verdict.summary,
        whyUseful: verdict.whyUseful,
        suggestedUse: verdict.suggestedUse,
        integrationApproach: approach,
        risks: verdict.risks,
        writeupMd,
        userStatus: "unread",
        createdAt: new Date(),
        sourceKind: "prune",
        discoveryMode: "prune",
        prunedDepName: dep.name,
        prunedDepEcosystem: dep.ecosystem,
        prunedDepAction: verdict.action,
        prunedDepVersion: dep.version,
        // Stored separately from writeup_md so cross-match consistency
        // (sprint 2) can join on it rather than regex the prose.
        prunedDepReplacement: verdict.action === "replace" ? (verdict.replacementName ?? null) : null,
      });
      totalMatches++;
      void recordEvent(
        runId,
        userId,
        "match",
        `Prune: ${dep.name} (${dep.ecosystem}) → ${p.slug} (${verdict.action} · ${tier} · ${verdict.score})`,
      );
    }
  }

  if (totalMatches > 0) {
    void recordEvent(runId, userId, "score", `Prune: ${totalMatches} suggestion(s) added across ${projects.length} project(s)`);
  }
  return { matchesCreated: totalMatches };
}

// Look up or create a minimal repos row for the targeted dep's GitHub
// repo. We don't run a full safety scan here — these are repos the user
// already trusts (they're in their own manifest), so the safety surface
// is different from "newly-discovered repo from gh-trending". Just
// populate enough columns that the feed UI can render the row.
async function ensureRepoRow(owner: string, name: string, health: UpstreamHealth): Promise<number> {
  // Case-insensitive lookup: a differently-cased existing repo is the same row
  // now (uniq_repo_ci). A case-sensitive miss followed by a plain INSERT would
  // trip the unique index and abort the whole prune phase (this call isn't in a
  // try). Fold case on lookup and absorb the conflict on insert.
  const existing = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(repoCiMatch(owner, name))
    .get();
  if (existing) return existing.id;

  const now = new Date();
  const inserted = await db
    .insert(schema.repos)
    .values({
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      description: null,
      stars: health.stars,
      pushedAt: health.lastPushIso ? new Date(health.lastPushIso) : null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.repos.id })
    .get();
  if (inserted?.id) return inserted.id;
  // Lost the race (or a case-variant already existed) — re-select.
  const row = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(repoCiMatch(owner, name))
    .get();
  if (!row) throw new Error(`could not ensure repo ${owner}/${name}`);
  return row.id;
}
