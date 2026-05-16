import { db, schema } from "../db/client";
import { and, eq, gte, sql } from "drizzle-orm";
import { runFetchers } from "../fetchers";
import { runAnalysis } from "../analyzer/pipeline";
import { sendDigestEmail } from "../email/send";
import { sendHighRelevanceWebhook } from "../email/webhook";
import { resolveUserConfig, type UserConfig } from "./user-config";
import { beginUsageTracking, endUsageTracking } from "../analyzer/llm";
import { totalCostUsd } from "../lib/pricing";

export async function runPipelineForUser(userId: number) {
  const cfg = await resolveUserConfig(userId);

  // Cost guardrail: sum the last 24h of runs against the user's cap. 0 = off.
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

  let errorLog: string | null = null;
  let candidatesFound = 0;
  let reposAnalyzed = 0;
  let matchesCreated = 0;
  let emailSent = false;

  beginUsageTracking();
  try {
    const fetched = await runFetchers(userId, cfg);
    candidatesFound = fetched.inserted;
    const analysis = await runAnalysis(run!.id, userId, cfg);
    reposAnalyzed = analysis.reposAnalyzed;
    matchesCreated = analysis.matchesCreated;
    emailSent = await sendDigestEmail(run!.id, userId, cfg);
    // Real-time webhook for `high` matches. Failures are logged but don't
    // poison the run - email is the canonical delivery.
    if (settings?.webhookUrl) {
      await sendHighRelevanceWebhook(run!.id, userId, settings.webhookUrl, settings.webhookKind ?? "generic")
        .catch((e) => console.warn(`[webhook] user=${userId} failed:`, e));
    }
  } catch (e) {
    errorLog = e instanceof Error ? e.stack ?? e.message : String(e);
    console.error(`[pipeline] user=${userId} failed`, e);
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
    })
    .where(eq(schema.digestRuns.id, run!.id));

  console.log(
    `[pipeline] done: user=${userId} run=${run!.id} candidates=${candidatesFound} repos=${reposAnalyzed} matches=${matchesCreated} email=${emailSent} cost=$${cost.toFixed(4)}`
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
