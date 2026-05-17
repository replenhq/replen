import { db, schema } from "../db/client";
import { and, eq, gte, sql } from "drizzle-orm";
import { runFetchers } from "../fetchers";
import { runAnalysis } from "../analyzer/pipeline";
import { sendDigestEmail } from "../email/send";
import { sendHighRelevanceWebhook } from "../email/webhook";
import { resolveUserConfig, type UserConfig } from "./user-config";
import { beginUsageTracking, endUsageTracking, LlmQuotaError } from "../analyzer/llm";
import { totalCostUsd } from "../lib/pricing";
import { recordEvent } from "./events";

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
    void recordEvent(runId, userId, "fetch_start", "Fetching candidates from your sources…");
    const fetched = await runFetchers(userId, cfg);
    candidatesFound = fetched.inserted;
    void recordEvent(runId, userId, "fetch_done", `Fetched ${fetched.inserted} new candidates (${fetched.total} total seen)`);
    const analysis = await runAnalysis(runId, userId, cfg);
    reposAnalyzed = analysis.reposAnalyzed;
    matchesCreated = analysis.matchesCreated;
    emailSent = await sendDigestEmail(runId, userId, cfg);
    // Real-time webhook for `high` matches. Failures are logged but don't
    // poison the run - email is the canonical delivery.
    if (settings?.webhookUrl) {
      await sendHighRelevanceWebhook(runId, userId, settings.webhookUrl, settings.webhookKind ?? "generic")
        .catch((e) => console.warn(`[webhook] user=${userId} failed:`, e));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export type { UserConfig };
