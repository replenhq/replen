import { db, schema } from "../db/client";
import { and, eq, gte, sql } from "drizzle-orm";
import { runFetchers } from "../fetchers";
import { runAnalysis } from "../analyzer/pipeline";
import { discoverLocalProjects, upsertProjects } from "../projects/loader";
import { sendDigestEmail } from "../email/send";
import { sendHighRelevanceWebhook } from "../email/webhook";
import { resolveUserConfig, type UserConfig } from "./user-config";
import { beginUsageTracking, endUsageTracking, LlmQuotaError } from "../analyzer/llm";
import { generateProjectSummary, needsRegeneration, PROMPT_VERSION, type ProjectSummary } from "../projects/summarize";
import { assessDocSparsity } from "../projects/self-improvement";
import {
  generateSearchVectors,
  vectorsNeedRegeneration,
  VECTORS_PROMPT_VERSION,
} from "../projects/search-vectors";
import { probeActivity } from "../projects/activity";
import { summariseActivity, needsActivityRefresh } from "../projects/activity-summary";
import { runPruneSuggestions } from "../projects/run-prune-suggestions";
import { runSynthesis } from "../projects/run-synthesis";
import { totalCostUsd } from "../lib/pricing";
import { recordEvent } from "./events";
import { readUserSecret } from "../lib/user-secrets";

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
    void recordEvent(runId, userId, "scan", "Loading project profiles from local docs…");
    await loadProjectsForUser(userId).catch((e) =>
      console.warn(`[pipeline] user=${userId} project load failed:`, e),
    );
    // Stage-1: structured summary + outcome goals per project.
    // Stage-2: search vectors derived from the summary.
    // Both run BEFORE the fetcher so that on the first pipeline run the
    // gh-targeted scouter has search vectors to query GitHub with, and the
    // reasoning step has summaries to compare candidates against. Cache check
    // in needsRegeneration/vectorsNeedRegeneration skips both on subsequent
    // runs unless profileHash/summaryHash changed — steady-state cost is zero.
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
    void recordEvent(runId, userId, "fetch_start", "Fetching candidates from your sources…");
    const fetched = await runFetchers(userId, cfg);
    candidatesFound = fetched.inserted;
    void recordEvent(runId, userId, "fetch_done", `Fetched ${fetched.inserted} new candidates (${fetched.total} total seen)`);
    const analysis = await runAnalysis(runId, userId, cfg);
    reposAnalyzed = analysis.reposAnalyzed;
    matchesCreated = analysis.matchesCreated;
    // Initiative #2: prune suggestions for stale dependencies. Runs after
    // analysis so prune matches show up in the same digest email as the
    // discovery + scouted matches. Failures are logged but never poison
    // the run — the regular feed has already shipped by now.
    try {
      const pruneResult = await runPruneSuggestions(runId, userId);
      matchesCreated += pruneResult.matchesCreated;
    } catch (e) {
      if (e instanceof LlmQuotaError) throw e;
      console.warn(`[pipeline] user=${userId} prune suggestions failed:`, e);
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

// Reads the user's project READMEs / CLAUDE.md files from the filesystem
// mirror (GITHUB_ROOT) and upserts a row per project into project_profiles.
// Idempotent: unchanged READMEs hash the same and the loader leaves their
// row alone. The user's `included` / `sensitivity` UI toggles are preserved.
//
// This used to live inside runAnalysis (pipeline.ts) but was moved out so
// that Stage 1 + 2 + the gh-targeted fetcher can all run with project rows
// already populated — see comment in runPipelineInner above.
async function loadProjectsForUser(userId: number): Promise<void> {
  const githubRoot = process.env.GITHUB_ROOT ?? process.cwd();
  const settings = await db
    .select({ extraDocPaths: schema.userSettings.extraDocPaths })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  const extraDocPaths = (settings?.extraDocPaths ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const discovered = await discoverLocalProjects(githubRoot, { extraDocPaths });
  await upsertProjects(discovered, userId);
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
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true)));
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
      void recordEvent(runId, userId, "scan", `Refreshing project context for ${p.slug} (${decision.reason})`);
      try {
        const summary = await generateProjectSummary({
          name: p.name,
          slug: p.slug,
          readmeMd: p.readmeMd,
          claudeMd: p.claudeMd,
          techSummary: p.techSummary,
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
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true)));
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
      void recordEvent(runId, userId, "scan", `Generating search vectors for ${p.slug} (${decision.reason})`);
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

// Initiative #1: activity refresh. For each active project, probe git for
// recent commits + open PRs + TODO clusters (cheap, no LLM), then summarise
// via LLM only when the cache is stale (>24h) or git HEAD has moved.
// Mirrors the cache-invalidation pattern of refreshStaleProjectSummaries and
// refreshStaleSearchVectors so steady-state cost is zero on subsequent runs.
async function refreshStaleActivity(runId: number, userId: number, cfg: UserConfig): Promise<void> {
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true)));
  if (projects.length === 0) return;

  let regenerated = 0;
  const ACTIVITY_CONCURRENCY = 3;
  let cursor = 0;
  const refreshOne = async () => {
    while (cursor < projects.length) {
      const idx = cursor++;
      const p = projects[idx];

      // Cheap pre-probe to get the current HEAD sha — the cache predicate
      // wants to know whether HEAD has moved since the last summary, so
      // we have to probe SOMETHING. Doing a full probeActivity is expensive;
      // we just want the sha here, the full probe runs only when stale.
      let currentHeadSha: string | null = null;
      try {
        const quick = await probeActivity(p.path, {});
        currentHeadSha = quick.headSha;
      } catch {
        // Project path missing or not a git repo. Skip silently — same
        // treatment as a project with no docs.
        continue;
      }

      const decision = needsActivityRefresh({
        activityJson: p.activityJson ?? null,
        activityGeneratedAt: p.activityGeneratedAt ?? null,
        activityHeadSha: p.activityHeadSha ?? null,
        currentHeadSha,
      });
      if (!decision.regen) continue;

      void recordEvent(runId, userId, "scan", `Refreshing activity for ${p.slug} (${decision.reason})`);

      try {
        // Full probe + LLM summary. The pre-probe above already proved
        // the project is a git repo, so we expect this to produce real data.
        const activity = await probeActivity(p.path, {
          githubFullName: p.githubFullName,
          ghToken: cfg.githubToken,
        });
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
        console.warn(`[pipeline] user=${userId} activity for ${p.slug} failed:`, e);
      }
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, projects.length) }, () => refreshOne()),
  );
  if (regenerated > 0) {
    void recordEvent(runId, userId, "scan", `Activity refreshed for ${regenerated} project(s)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export type { UserConfig };
