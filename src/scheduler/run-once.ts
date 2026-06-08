import { db, schema } from "../db/client";
import { and, eq, gte, sql } from "drizzle-orm";
import { runDiscoveredFetchers, runScoutedFetchers } from "../fetchers";
import { runAnalysis } from "../analyzer/pipeline";
import { discoverProjectsForUser, parseShapeJson, upsertProjects } from "../projects/loader";
import { sendDigestEmail } from "../email/send";
import { sendHighRelevanceWebhook } from "../email/webhook";
import { resolveUserConfig, type UserConfig } from "./user-config";
import { beginUsageTracking, endUsageTracking, hasPrimaryKey, LlmQuotaError } from "../analyzer/llm";
import {
  embed,
  embedBatch,
  projectEmbeddingText,
  serialiseEmbedding,
  selectFacetLabels,
  facetEmbeddingText,
  serialiseFacetEmbeddings,
  facetSetHash,
  type FacetEmbedding,
} from "../lib/embeddings";
import { createHash } from "node:crypto";
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
import { generateProjectSummary, needsRegeneration, PROMPT_VERSION, type ProjectSummary } from "../projects/summarize";
import { assessDocSparsity } from "../projects/self-improvement";
import {
  generateSearchVectors,
  vectorsNeedRegeneration,
  VECTORS_PROMPT_VERSION,
} from "../projects/search-vectors";
import { probeActivityViaApi } from "../github/activity-via-api";
import { GitHubApiError } from "../github/repo-content";
import { summariseActivity, needsActivityRefresh } from "../projects/activity-summary";
import { runPruneSuggestions } from "../projects/run-prune-suggestions";
import { runSynthesis } from "../projects/run-synthesis";
import { totalCostUsd } from "../lib/pricing";
import { recordEvent } from "./events";
import { readUserSecret } from "../lib/user-secrets";
import { detectPruneConflicts, type PruneVerdict } from "../analyzer/eligibility";
import { inArray } from "drizzle-orm";

// Translate internal "regen needed" reason codes into friendlier labels for
// the streamer. New-user signals like "no-summary" / "no-vectors" / "no-
// activity" read as failures to first-time visitors — they're not, they
// just mean "no cache yet, building it now". Everything else passes through.
function friendlyRegenReason(reason: string): string {
  switch (reason) {
    case "no-summary":
    case "no-vectors":
    case "no-activity":
    case "no-summary-yet":
      return "first run";
    case "stale":
    case "stale-summary":
    case "stale-vectors":
    case "stale-activity":
      return "refreshing";
    case "head-changed":
      return "repo updated";
    case "prompt-version-bump":
      return "prompt updated";
    default:
      return reason;
  }
}

// Synchronously creates the digest_runs row (so the dashboard query sees an
// in-flight run on the very next render) and kicks off the actual pipeline
// work fire-and-forget. Returns immediately. Callers (server actions, cron)
// who want to *await* the full pipeline can call runPipelineForUser instead.
export async function startPipelineForUser(userId: number): Promise<{ runId: number } | { skipped: string }> {
  const cfg = await resolveUserConfig(userId);
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).get();

  const cap = Number(settings?.dailyCostCapUsd ?? 0);
  if (cap > 0) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const sumRow = await db
      .select({ s: sql<number>`coalesce(sum(${schema.digestRuns.costUsd}), 0)` })
      .from(schema.digestRuns)
      .where(and(eq(schema.digestRuns.userId, userId), gte(schema.digestRuns.startedAt, since)))
      .get();
    const spent24h = Number(sumRow?.s ?? 0);
    if (spent24h >= cap) {
      console.warn(`[pipeline] user=${userId} skipped: 24h spend $${spent24h.toFixed(2)} >= cap $${cap.toFixed(2)}`);
      await db.insert(schema.digestRuns).values({
        userId,
        startedAt: new Date(),
        finishedAt: new Date(),
        pausedReason: `cost-cap (24h $${spent24h.toFixed(2)} ≥ $${cap.toFixed(2)})`,
      });
      return { skipped: "cost-cap" };
    }
  }

  const run = await db
    .insert(schema.digestRuns)
    .values({ userId, startedAt: new Date() })
    .returning()
    .get();

  void executePipeline(run!.id, userId, cfg, settings).catch((e) =>
    console.error(`[pipeline] user=${userId} fire-and-forget execute crashed:`, e),
  );
  return { runId: run!.id };
}

// Awaits the full pipeline. Used by the scheduler cron + the CLI scripts.
// The server action `runPipelineNow` uses startPipelineForUser instead so the
// HTTP response returns the moment the row is visible to other queries.
export async function runPipelineForUser(userId: number) {
  const cfg = await resolveUserConfig(userId);
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).get();

  const cap = Number(settings?.dailyCostCapUsd ?? 0);
  if (cap > 0) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const sumRow = await db
      .select({ s: sql<number>`coalesce(sum(${schema.digestRuns.costUsd}), 0)` })
      .from(schema.digestRuns)
      .where(and(eq(schema.digestRuns.userId, userId), gte(schema.digestRuns.startedAt, since)))
      .get();
    const spent24h = Number(sumRow?.s ?? 0);
    if (spent24h >= cap) {
      console.warn(`[pipeline] user=${userId} skipped: 24h spend $${spent24h.toFixed(2)} >= cap $${cap.toFixed(2)}`);
      await db.insert(schema.digestRuns).values({
        userId,
        startedAt: new Date(),
        finishedAt: new Date(),
        pausedReason: `cost-cap (24h $${spent24h.toFixed(2)} ≥ $${cap.toFixed(2)})`,
      });
      return;
    }
  }

  const run = await db
    .insert(schema.digestRuns)
    .values({ userId, startedAt: new Date() })
    .returning()
    .get();

  await executePipeline(run!.id, userId, cfg, settings);
}

async function executePipeline(
  runId: number,
  userId: number,
  cfg: UserConfig,
  settings: typeof schema.userSettings.$inferSelect | undefined,
) {
  let errorLog: string | null = null;
  let pausedReason: string | null = null;
  let candidatesFound = 0;
  let reposAnalyzed = 0;
  let matchesCreated = 0;
  let emailSent = false;

  beginUsageTracking();
  try {
    // Load project READMEs / CLAUDE.mds from the filesystem mirror into
    // project_profiles BEFORE anything else. Subsequent Stage 1 + 2 + the
    // gh-targeted fetcher all key off these rows; on a brand-new user this
    // is the only chance to populate them before they're needed.
    void recordEvent(runId, userId, "scan", "Loading project profiles from GitHub…");
    await loadProjectsForUser(runId, userId, cfg).catch((e) =>
      console.warn(`[pipeline] user=${userId} project load failed:`, e),
    );
    // Phase 1 — Discovered pool. Runs BEFORE Stages 1/2 so first-time
    // users see candidate inventory within ~30-60s of install instead of
    // waiting for the per-project LLM work (Stage 1 summaries + Stage 2
    // search vectors) to chew through every project. The discovered
    // fetchers (gh-trending, HN, Reddit, TikTok, Threads, ossinsight,
    // historical-search, gh-search, gh-search-recent) are language/topic-
    // based and don't depend on per-project Stage-2 output.
    void recordEvent(runId, userId, "fetch_start", "Pulling candidates from your sources…");
    const discovered = await runDiscoveredFetchers(userId, cfg);
    candidatesFound = discovered.inserted;
    void recordEvent(runId, userId, "fetch_done", `Discovered pool: ${discovered.inserted} new candidate(s) (${discovered.total} seen)`);

    // Phase 2 — Per-project LLM work.
    // Stage-1: structured summary + outcome goals per project.
    // Stage-2: search vectors derived from the summary.
    // These power per-project relevance for the scouted fetcher in
    // Phase 3 and for the (hosted-tier) Stage 3+ reasoning. Cache check
    // in needsRegeneration/vectorsNeedRegeneration skips both on
    // subsequent runs unless profileHash/summaryHash changed — steady-
    // state cost is zero. Silently skipped when no LLM_PRIMARY_API_KEY
    // is configured (e.g. self-host without a key); scouted pool will
    // then come up empty but discovered pool from Phase 1 still works.
    await refreshStaleProjectSummaries(runId, userId).catch((e) =>
      console.warn(`[pipeline] user=${userId} summary refresh failed:`, e),
    );
    await refreshStaleSearchVectors(runId, userId).catch((e) =>
      console.warn(`[pipeline] user=${userId} vectors refresh failed:`, e),
    );
    // Initiative #1: capture what each project's been actively working on
    // (recent commits, open PRs, TODOs) so Stage 4 + reasonAboutRepo can
    // grade matches against current work, not just the project's general
    // doc shape. Cheap: short-circuits to dormant when no commits, caches
    // 24h or until git HEAD moves.
    await refreshStaleActivity(runId, userId, cfg).catch((e) =>
      console.warn(`[pipeline] user=${userId} activity refresh failed:`, e),
    );

    // Project embeddings (semantic matcher query vectors). Runs after
    // Stage 1+2 so the embedded text reflects the freshest summary +
    // outcome goals + tags. Cheap (~$0.000005 per project, only when
    // content hash changed). Failures are non-fatal — the inventory
    // query falls back to the legacy tag-intersection path when a
    // project's embedding is missing.
    await refreshStaleProjectEmbeddings(runId, userId).catch((e) =>
      console.warn(`[pipeline] user=${userId} project embeddings failed:`, e),
    );

    // Phase 3 — Scouted pool. Uses the per-project search vectors built
    // in Phase 2 to issue targeted GitHub searches. On a project's first
    // pipeline run this returns zero (no vectors yet) — that's by design;
    // the user already has the discovered pool from Phase 1 and scouted
    // matches appear on the second run once vectors exist.
    const scouted = await runScoutedFetchers(userId, cfg);
    candidatesFound += scouted.inserted;
    if (scouted.inserted > 0 || scouted.total > 0) {
      void recordEvent(runId, userId, "fetch_done", `Scouted pool: ${scouted.inserted} new candidate(s) (${scouted.total} seen)`);
    }

    // Skill-tier short-circuit: stages 3-5 (analysis, prune, digest,
    // synthesis) run in the user's Claude Code / Codex session via
    // /replen-match, using subscription tokens. The server side stops
    // at the candidate inventory + eligibility filter. Hosted-tier
    // users keep the full pipeline.
    if ((settings?.subscriptionTier ?? "skill") === "skill") {
      void recordEvent(
        runId,
        userId,
        "scan",
        "Skill tier: stages 3-5 run in-session via /replen-match. Candidate inventory ready.",
      );
      return;
    }

    const analysis = await runAnalysis(runId, userId, cfg);
    reposAnalyzed = analysis.reposAnalyzed;
    matchesCreated = analysis.matchesCreated;
    // Initiative #2: prune suggestions for stale dependencies. Runs after
    // analysis so prune matches show up in the same digest email as the
    // discovery + scouted matches. Failures are logged but never poison
    // the run — the regular feed has already shipped by now.
    try {
      const pruneResult = await runPruneSuggestions(runId, userId, cfg.githubToken);
      matchesCreated += pruneResult.matchesCreated;
    } catch (e) {
      if (e instanceof LlmQuotaError) throw e;
      console.warn(`[pipeline] user=${userId} prune suggestions failed:`, e);
    }
    // Pipeline v2 / Sprint 2 — cross-match consistency. Detect the
    // "drop X / replace Y with X" contradiction we saw on
    // tech-news-site (fluent-ffmpeg flagged as dead in one match while
    // @ffmpeg-installer was being replaced WITH fluent-ffmpeg in the
    // next). Runs after both regular + prune matches have landed so the
    // full set is visible.
    try {
      const dropped = await reconcilePruneContradictions(runId, userId);
      if (dropped > 0) {
        matchesCreated -= dropped;
        void recordEvent(runId, userId, "skip", `Cross-match consistency: hid ${dropped} contradicting prune match${dropped === 1 ? "" : "es"}`);
      }
    } catch (e) {
      console.warn(`[pipeline] user=${userId} cross-match consistency failed:`, e);
    }
    // Initiative #3: synthesise meta-insights across this run's matches.
    // Runs after prune so prune matches are also eligible as evidence.
    // Failures non-fatal: insights are a "nice to have" on top of the
    // canonical match feed.
    try {
      await runSynthesis(runId, userId);
    } catch (e) {
      if (e instanceof LlmQuotaError) throw e;
      console.warn(`[pipeline] user=${userId} synthesis failed:`, e);
    }
    emailSent = await sendDigestEmail(runId, userId, cfg);
    // Real-time webhook for `high` matches. Failures are logged but don't
    // poison the run - email is the canonical delivery. The URL is stored
    // encrypted at rest (audit M1 — bearer-equivalent for Slack/Discord),
    // so decrypt right before send and never widen its scope.
    if (settings?.webhookUrl) {
      try {
        const url = await readUserSecret(userId, "webhookUrl", settings.webhookUrl, "webhook-send");
        if (url) {
          await sendHighRelevanceWebhook(runId, userId, url, settings.webhookKind ?? "generic")
            .catch((e) => console.warn(`[webhook] user=${userId} failed:`, e));
        }
      } catch (e) {
        console.warn(`[webhook] user=${userId} decrypt failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    errorLog = e instanceof Error ? e.stack ?? e.message : String(e);
    if (e instanceof LlmQuotaError) {
      pausedReason = `llm-quota:${e.slot}`;
      void recordEvent(
        runId,
        userId,
        "error",
        `${e.slot === "primary" ? "Primary" : "Sensitive"} LLM out of credits. Top up your API balance or switch providers on /settings.`,
      );
      console.warn(`[pipeline] user=${userId} stopped: ${e.message}`);
    } else {
      console.error(`[pipeline] user=${userId} failed`, e);
    }
  }
  const usage = endUsageTracking();
  const cost = totalCostUsd(usage.calls);

  await db
    .update(schema.digestRuns)
    .set({
      finishedAt: new Date(),
      candidatesFound,
      reposAnalyzed,
      matchesCreated,
      emailSent,
      errorLog,
      deepseekInputTokens: usage.deepseekInputTokens,
      deepseekOutputTokens: usage.deepseekOutputTokens,
      anthropicInputTokens: usage.anthropicInputTokens,
      anthropicOutputTokens: usage.anthropicOutputTokens,
      costUsd: cost,
      pausedReason,
    })
    .where(eq(schema.digestRuns.id, runId));

  console.log(
    `[pipeline] done: user=${userId} run=${runId} candidates=${candidatesFound} repos=${reposAnalyzed} matches=${matchesCreated} email=${emailSent} cost=$${cost.toFixed(4)}`
  );
}

/**
 * Iterates every active user with enabled settings and runs their pipeline.
 * Falls back to a single "default" run with env-vars-only when no users exist yet
 * (so the CLI keeps working pre-Phase-2-sign-in).
 */
export async function runPipeline() {
  const activeUsers = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.status, "active"));

  if (activeUsers.length === 0) {
    console.log("[pipeline] no users yet - skipping (sign in once to bootstrap)");
    return;
  }

  // Parallelise with a small cap so a slow user doesn't stall the queue, but
  // we don't thunder on GitHub / LLM quota either.
  const CONCURRENCY = parseInt(process.env.PIPELINE_USER_CONCURRENCY ?? "3", 10);
  const queue = [...activeUsers];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const u = queue.shift();
      if (!u) return;
      try {
        await runPipelineForUser(u.id);
      } catch (e) {
        console.error(`[pipeline] user=${u.id} (${u.email}) failed`, e);
      }
    }
  });
  await Promise.all(workers);
}

// Reads the user's project READMEs / CLAUDE.md files via the GitHub
// API (using the per-user PAT from user_settings.githubToken) and
// upserts a row per project into project_profiles. Idempotent:
// unchanged repo contents hash the same and the loader leaves their
// row alone. The user's `included` / `sensitivity` UI toggles are
// preserved.
//
// Only refreshes rows that already exist + have github_full_name set.
// New repos enter project_profiles via autoDetectAndStoreRepos (on
// settings PAT save + the explicit /projects Re-detect button), so
// pipeline runs stay cheap.
//
// When the user has no PAT, this no-ops and existing rows continue
// serving whatever docs they were last loaded with — the steady-state
// matching pipeline keeps working with stale data rather than going
// blank.
async function loadProjectsForUser(runId: number, userId: number, cfg: UserConfig): Promise<void> {
  if (!cfg.githubToken) {
    void recordEvent(runId, userId, "scan", "Project load skipped: no GitHub PAT on /settings");
    return;
  }
  const settings = await db
    .select({ extraDocPaths: schema.userSettings.extraDocPaths })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  const extraDocPaths = (settings?.extraDocPaths ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const { projects, skippedNoRepo } = await discoverProjectsForUser(userId, cfg.githubToken, { extraDocPaths });
  await upsertProjects(projects, userId);
  if (skippedNoRepo.length > 0) {
    void recordEvent(
      runId,
      userId,
      "scan",
      `Project load: ${skippedNoRepo.length} project(s) need a GitHub repo set on /projects: ${skippedNoRepo.slice(0, 5).join(", ")}${skippedNoRepo.length > 5 ? `, +${skippedNoRepo.length - 5} more` : ""}`,
    );
  }
}

// Stage-1 hook. Iterates the user's active projects, regenerates the
// structured summary for any that are stale (per the hybrid invalidation
// policy in summarize.ts), and persists. Also records a `summary` event for
// each refresh and an explicit "sparse docs" event for projects where the
// summary inputs are too thin — that surfaces a hint on the dashboard
// activity log so the user knows to open a docs PR via /projects/[slug].
//
// Capped concurrency to avoid LLM rate-limit issues when the user has many
// projects. Errors per-project are swallowed; one bad project doesn't kill
// the whole refresh.
async function refreshStaleProjectSummaries(runId: number, userId: number): Promise<void> {
  if (!hasPrimaryKey()) {
    void recordEvent(
      runId,
      userId,
      "scan",
      "Stage 1 (project summaries) skipped: no LLM_PRIMARY_API_KEY configured. Active scouting will be disabled; discovered-pool matches only. Set LLM_PRIMARY_API_KEY to enable.",
    );
    return;
  }
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      // Respect the /projects "include" toggle on pre-analysis stages too —
      // not just downstream matching. Excluded projects shouldn't burn
      // LLM calls on stage-1 summaries, stage-2 vectors, or activity
      // probes, and shouldn't clutter the streamer with sparse-docs
      // hints either. The downstream score-targeted + analyzer +
      // reason layers already enforce included; this widens the gate
      // to the early pipeline as well.
      eq(schema.projectProfiles.included, true),
    ));
  if (projects.length === 0) return;

  const SUMMARY_CONCURRENCY = 3;
  let cursor = 0;
  const refreshOne = async () => {
    while (cursor < projects.length) {
      const idx = cursor++;
      const p = projects[idx];
      const decision = needsRegeneration({
        summaryJson: p.summaryJson ?? null,
        summaryHash: p.summaryHash ?? null,
        summaryGeneratedAt: p.summaryGeneratedAt ?? null,
        summaryPromptVersion: p.summaryPromptVersion ?? null,
        currentProfileHash: p.profileHash,
      });
      // Always assess sparsity even when summary is fresh — surfaces hint on
      // the activity log every run so users see it.
      const sparsity = assessDocSparsity(p);
      if (sparsity.sparse) {
        void recordEvent(
          runId,
          userId,
          "skip",
          `Sparse docs in ${p.slug} — ${sparsity.reasons.join("; ")}. Open a docs PR on /projects/${p.slug}.`,
        );
      }
      if (!decision.regen) continue;
      void recordEvent(runId, userId, "scan", `Refreshing project context for ${p.slug} (${friendlyRegenReason(decision.reason)})`);
      try {
        const summary = await generateProjectSummary({
          name: p.name,
          slug: p.slug,
          readmeMd: p.readmeMd,
          claudeMd: p.claudeMd,
          techSummary: p.techSummary,
          shape: parseShapeJson(p.shapeJson),
        });
        if (!summary) continue; // project has no docs at all — skip silently
        await db
          .update(schema.projectProfiles)
          .set({
            summaryJson: JSON.stringify(summary),
            summaryHash: p.profileHash,
            summaryGeneratedAt: new Date(),
            summaryPromptVersion: PROMPT_VERSION,
          })
          .where(eq(schema.projectProfiles.id, p.id));
      } catch (e) {
        // Quota errors here are NOT terminal for the run — the analyzer
        // already ran successfully. Just record and continue.
        console.warn(`[pipeline] user=${userId} summary refresh for ${p.slug} failed:`, e);
      }
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(SUMMARY_CONCURRENCY, projects.length) }, () => refreshOne()),
  );
}

// Stage-2 hook. Iterates the user's active projects with a fresh Stage-1
// summary, regenerates SearchVectors for any whose vectors are stale, and
// persists. Records a "scan" event per regen and a "match" event count
// summary at the end. Capped concurrency 3 (same as summary refresh).
async function refreshStaleSearchVectors(runId: number, userId: number): Promise<void> {
  if (!hasPrimaryKey()) {
    // No event recorded here — refreshStaleProjectSummaries already emitted
    // the user-facing "Stage 1 skipped" message. This call is a silent no-op
    // because without Stage 1 summaries there's nothing to generate vectors
    // from anyway.
    return;
  }
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      // Respect the /projects "include" toggle on pre-analysis stages too —
      // not just downstream matching. Excluded projects shouldn't burn
      // LLM calls on stage-1 summaries, stage-2 vectors, or activity
      // probes, and shouldn't clutter the streamer with sparse-docs
      // hints either. The downstream score-targeted + analyzer +
      // reason layers already enforce included; this widens the gate
      // to the early pipeline as well.
      eq(schema.projectProfiles.included, true),
    ));
  if (projects.length === 0) return;

  let regenerated = 0;
  const VECTOR_CONCURRENCY = 3;
  let cursor = 0;
  const refreshOne = async () => {
    while (cursor < projects.length) {
      const idx = cursor++;
      const p = projects[idx];
      const decision = vectorsNeedRegeneration({
        searchVectorsJson: p.searchVectorsJson ?? null,
        searchVectorsSummaryHash: p.searchVectorsSummaryHash ?? null,
        searchVectorsGeneratedAt: p.searchVectorsGeneratedAt ?? null,
        searchVectorsPromptVersion: p.searchVectorsPromptVersion ?? null,
        currentSummaryHash: p.summaryHash ?? null,
      });
      if (!decision.regen) continue;
      if (!p.summaryJson || !p.summaryHash) continue; // no summary → skip silently
      let summary: ProjectSummary;
      try {
        summary = JSON.parse(p.summaryJson) as ProjectSummary;
      } catch {
        continue;
      }
      void recordEvent(runId, userId, "scan", `Generating search vectors for ${p.slug} (${friendlyRegenReason(decision.reason)})`);
      try {
        const vectors = await generateSearchVectors(summary, p.summaryHash);
        if (!vectors) continue;
        await db
          .update(schema.projectProfiles)
          .set({
            searchVectorsJson: JSON.stringify(vectors),
            searchVectorsSummaryHash: p.summaryHash,
            searchVectorsGeneratedAt: new Date(),
            searchVectorsPromptVersion: VECTORS_PROMPT_VERSION,
          })
          .where(eq(schema.projectProfiles.id, p.id));
        regenerated++;
      } catch (e) {
        console.warn(`[pipeline] user=${userId} vectors for ${p.slug} failed:`, e);
      }
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(VECTOR_CONCURRENCY, projects.length) }, () => refreshOne()),
  );
  if (regenerated > 0) {
    void recordEvent(runId, userId, "scan", `Search vectors refreshed for ${regenerated} project(s)`);
  }
}

// Semantic embeddings for projects. Computes the "what this project
// is about" query vector that /api/inventory/today uses to rank
// candidates by cosine similarity. Cached by content hash: only
// re-embeds when the project's summary / outcome-goals / tags
// content actually changes. Cost is ~$0.000005 per regen on
// text-embedding-3-small; steady-state cost is zero.
async function refreshStaleProjectEmbeddings(runId: number, userId: number): Promise<void> {
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      eq(schema.projectProfiles.included, true),
    ));
  if (projects.length === 0) return;

  let regenerated = 0;
  let skippedNoSummary = 0;
  for (const p of projects) {
    // Parse the project's data into the embedding-text shape.
    let summary: ProjectSummary | null = null;
    if (p.summaryJson) {
      try { summary = JSON.parse(p.summaryJson) as ProjectSummary; } catch { /* ignore */ }
    }
    let tags: string[] = [];
    if (p.tags) {
      try {
        const arr = JSON.parse(p.tags);
        if (Array.isArray(arr)) tags = arr.filter((t): t is string => typeof t === "string");
      } catch { /* ignore */ }
    }
    if (!summary && tags.length === 0 && !p.name) {
      skippedNoSummary++;
      continue;
    }

    const text = projectEmbeddingText({
      name: p.name ?? null,
      oneLiner: summary?.purpose ?? null,
      niche: summary?.keyCapabilities?.join(", ") ?? null,
      outcomeGoals: summary?.outcomeGoals?.map((g) => g.statement) ?? null,
      tags,
      primaryLanguage: null,
    });
    if (!text) continue;

    const contentHash = sha256Hex(text);

    // Per-capability facet vectors (Phase 1). The centroid above matches whole-
    // apps in the same domain; facet vectors let a candidate match the project's
    // strongest SINGLE capability (a CV library matches "computer vision" even
    // when it's far from the blended centroid). Regenerated independently of the
    // centroid: keyed on the capability label set, not the full project text.
    // Prefer the clean capabilityTags (Phase 2) — short tech terms like
    // "computer vision" that embed to the right region and match capability
    // libraries. Fall back to the verbose keyCapabilities for old summaries
    // that predate capabilityTags (until they regenerate).
    const facetSource = (summary?.capabilityTags?.length ? summary.capabilityTags : summary?.keyCapabilities) ?? [];
    const facetLabels = selectFacetLabels(facetSource);
    const facetHash = facetSetHash(facetLabels);
    let storedFacetHash: string | null = null;
    if (p.facetEmbeddings) {
      try { storedFacetHash = (JSON.parse(p.facetEmbeddings) as { hash?: string }).hash ?? null; } catch { /* regen */ }
    }

    const centroidStale = !(p.embeddingContentHash === contentHash && p.embedding);
    const facetsStale = storedFacetHash !== facetHash;
    if (!centroidStale && !facetsStale) continue; // cache hit on both

    const set: Partial<typeof schema.projectProfiles.$inferInsert> = { updatedAt: new Date() };

    if (centroidStale) {
      const result = await embed(text);
      if (!result) continue; // API down / no key — leave both for next run
      set.embedding = serialiseEmbedding(result.vector);
      set.embeddingContentHash = contentHash;
      set.embeddingGeneratedAt = result.generatedAt;
    }

    if (facetsStale) {
      if (facetLabels.length === 0) {
        // Nothing to probe — record the empty set so we don't retry every run.
        set.facetEmbeddings = serialiseFacetEmbeddings({ hash: facetHash, facets: [] });
      } else {
        const vecs = await embedBatch(facetLabels.map(facetEmbeddingText));
        const facets: FacetEmbedding[] = [];
        for (let i = 0; i < facetLabels.length; i++) {
          const r = vecs[i];
          if (r) facets.push({ label: facetLabels[i], vec: r.vector });
        }
        // Only persist when at least one facet embedded — an all-null batch
        // means the API/key is down; leave facetEmbeddings untouched to retry.
        if (facets.length > 0) {
          set.facetEmbeddings = serialiseFacetEmbeddings({ hash: facetHash, facets });
        }
      }
    }

    // Nothing actually produced (e.g. facets stale but batch failed and centroid
    // fresh) — skip the write.
    if (set.embedding === undefined && set.facetEmbeddings === undefined) continue;

    await db
      .update(schema.projectProfiles)
      .set(set)
      .where(eq(schema.projectProfiles.id, p.id));
    regenerated++;
  }
  if (regenerated > 0) {
    void recordEvent(runId, userId, "scan", `Project embeddings refreshed for ${regenerated} project(s)`);
  }
  if (skippedNoSummary > 0) {
    void recordEvent(runId, userId, "scan", `Project embeddings skipped for ${skippedNoSummary} project(s) (no summary or tags yet)`);
  }
}

// Initiative #1: activity refresh. For each active project with a known
// github_full_name, probe via GitHub API for recent commits + open PRs +
// TODO clusters (cheap, no LLM), then summarise via LLM only when the
// cache is stale (>24h) or git HEAD has moved.
//
// Replaces the previous filesystem-based probe: prod doesn't have
// .git/ in the projects-mirror so the local probe always returned
// empty. GitHub API works wherever the pipeline runs.
//
// Projects with no github_full_name are skipped (can't address them).
// The auto-detect on /settings PAT save normally fills this in;
// /projects also lets the user set it manually.
async function refreshStaleActivity(runId: number, userId: number, cfg: UserConfig): Promise<void> {
  if (!cfg.githubToken) {
    void recordEvent(runId, userId, "scan", "Activity refresh skipped: no GitHub PAT on /settings");
    return;
  }
  if (!hasPrimaryKey()) {
    // Activity probing is cheap (GitHub API only), but the LLM summarisation
    // step that turns the raw signal into "currently working on X" requires
    // the primary slot. Without a key, skip silently — the Stage 1 skip
    // event already explained the situation to the user.
    return;
  }
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      // Respect the /projects "include" toggle on pre-analysis stages too —
      // not just downstream matching. Excluded projects shouldn't burn
      // LLM calls on stage-1 summaries, stage-2 vectors, or activity
      // probes, and shouldn't clutter the streamer with sparse-docs
      // hints either. The downstream score-targeted + analyzer +
      // reason layers already enforce included; this widens the gate
      // to the early pipeline as well.
      eq(schema.projectProfiles.included, true),
    ));
  if (projects.length === 0) return;
  const token = cfg.githubToken;

  let regenerated = 0;
  // Use a box so TS preserves the type across the closure boundary
  // even when only one branch ever assigns it.
  const rateLimitBox: { value: { retryAfterMs: number | undefined } | null } = { value: null };
  const ACTIVITY_CONCURRENCY = 3;
  let cursor = 0;
  const refreshOne = async () => {
    while (cursor < projects.length) {
      const idx = cursor++;
      const p = projects[idx];
      if (rateLimitBox.value) return;

      if (!p.githubFullName || !/^[\w.-]+\/[\w.-]+$/.test(p.githubFullName)) {
        // No GitHub repo set: can't probe via API. Don't log per-project
        // (would spam); summary line at the end covers it.
        continue;
      }
      const [owner, repoName] = p.githubFullName.split("/");

      let activity;
      try {
        activity = await probeActivityViaApi(owner, repoName, token);
      } catch (e) {
        if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) {
          // Rate-limited. Stop the loop — no point burning more calls.
          // The orchestrator-level catch in runPipelineInner records a
          // separate event; here we just bail.
          rateLimitBox.value = { retryAfterMs: e.retryAfterMs };
          return;
        }
        console.warn(`[pipeline] user=${userId} activity probe for ${p.slug} (${p.githubFullName}) failed:`, e);
        continue;
      }
      if (!activity.isGitRepo) continue;

      const decision = needsActivityRefresh({
        activityJson: p.activityJson ?? null,
        activityGeneratedAt: p.activityGeneratedAt ?? null,
        activityHeadSha: p.activityHeadSha ?? null,
        currentHeadSha: activity.headSha,
      });
      if (!decision.regen) continue;

      void recordEvent(runId, userId, "scan", `Refreshing activity for ${p.slug} (${friendlyRegenReason(decision.reason)})`);

      try {
        const summary = await summariseActivity(activity, p.name, p.slug, {
          sensitivity: (p.sensitivity as "low" | "high") ?? "low",
        });
        if (!summary) continue;
        await db
          .update(schema.projectProfiles)
          .set({
            activityJson: JSON.stringify(summary),
            activityGeneratedAt: new Date(),
            activityHeadSha: activity.headSha,
          })
          .where(eq(schema.projectProfiles.id, p.id));
        regenerated++;
      } catch (e) {
        if (e instanceof LlmQuotaError) throw e;
        console.warn(`[pipeline] user=${userId} activity summarise for ${p.slug} failed:`, e);
      }
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, projects.length) }, () => refreshOne()),
  );
  if (rateLimitBox.value) {
    const waitSec = rateLimitBox.value.retryAfterMs ? Math.ceil(rateLimitBox.value.retryAfterMs / 1000) : null;
    void recordEvent(
      runId,
      userId,
      "scan",
      `Activity refresh paused: GitHub API rate-limited${waitSec ? ` (retry in ${waitSec}s)` : ""}`,
    );
  }
  if (regenerated > 0) {
    void recordEvent(runId, userId, "scan", `Activity refreshed for ${regenerated} project(s)`);
  }
}

// Pipeline v2 / Sprint 2 — cross-match consistency. Scans the prune
// matches produced in this run and detects contradictions: e.g. one
// match recommends dropping fluent-ffmpeg as dead, while another
// recommends replacing @ffmpeg-installer/ffmpeg WITH fluent-ffmpeg.
// Both can't be true. We keep the higher-scored side and mark the
// loser as hidden (soft delete — reversible via /admin and doesn't
// drop the writeup in case the user wants to inspect what happened).
//
// Returns the count of hidden matches so the caller can adjust its
// matches-created accounting + emit a streamer event.
async function reconcilePruneContradictions(runId: number, userId: number): Promise<number> {
  const prunes = await db
    .select({
      id: schema.matches.id,
      action: schema.matches.prunedDepAction,
      depName: schema.matches.prunedDepName,
      replacement: schema.matches.prunedDepReplacement,
      score: schema.matches.relevanceScore,
    })
    .from(schema.matches)
    .where(and(
      eq(schema.matches.userId, userId),
      eq(schema.matches.runId, runId),
      eq(schema.matches.discoveryMode, "prune"),
    ));

  const verdicts: PruneVerdict[] = prunes
    .filter((p) => p.action === "drop" || p.action === "replace")
    .map((p) => ({
      matchId: p.id,
      action: p.action as "drop" | "replace",
      prunedDepName: p.depName ?? "",
      replacementName: p.replacement ?? null,
      relevanceScore: p.score ?? 0,
    }));

  const conflicts = detectPruneConflicts(verdicts);
  if (conflicts.length === 0) return 0;

  // Soft-hide the losers. Logging the reason on each so /admin can
  // diagnose what got auto-reconciled.
  const loserIds = conflicts.map((c) => c.loserMatchId);
  await db
    .update(schema.matches)
    .set({ userStatus: "hidden" })
    .where(and(
      eq(schema.matches.userId, userId),
      inArray(schema.matches.id, loserIds),
    ));
  for (const c of conflicts) {
    console.log(`[reconcile] match #${c.loserMatchId} hidden: ${c.reason}`);
  }
  return conflicts.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export type { UserConfig };
