// Resolves the configuration for a pipeline run for a given user.
// - User-set values always win.
// - Env-var fallback for LLM keys is GATED on users.canUseSharedLlm (admin grants it).
// - GitHub token: BYO only (never shared) - leaks attribute API calls to the user.
// - Email destination: per-user; falls back to env so admin keeps working.

import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { readUserSecret } from "../lib/user-secrets";

export type UserConfig = {
  userId: number;
  githubToken: string | undefined;
  // Generic LLM slots. Provider-agnostic. Each slot has a key + base URL +
  // model. The sensitive slot also has a wire-format hint ('anthropic' or
  // 'openai-compatible'). Empty means "no per-user override; fall back to
  // shared-env values via canUseSharedLlm".
  llmPrimaryApiKey: string | undefined;
  llmPrimaryBaseUrl: string | undefined;
  llmPrimaryModel: string | undefined;
  llmSensitiveApiKey: string | undefined;
  llmSensitiveBaseUrl: string | undefined;
  llmSensitiveModel: string | undefined;
  llmSensitiveWireFormat: string | undefined;
  // Legacy per-provider fields. Populated from the deepseekApiKey /
  // anthropicApiKey columns only when the generic slot above is empty.
  // Downstream pipeline code that sets DEEPSEEK_API_KEY / ANTHROPIC_API_KEY
  // env vars uses these.
  deepseekApiKey: string | undefined;
  anthropicApiKey: string | undefined;
  threadsHandles: string;
  redditSubs: string;
  tiktokHandles: string;
  emailToAddress: string | undefined;
  // Comma-separated primary languages detected from the user's own GitHub
  // repos. Drives the per-language slices the gh-trending fetcher pulls.
  detectedLanguages: string | null;
};

export async function resolveUserConfig(userId: number): Promise<UserConfig> {
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) throw new Error(`user ${userId} not found`);

  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).get();
  const curated = await db.select().from(schema.curatedSources);

  const curatedThreads = curated.filter((c) => c.kind === "threads").map((c) => c.value);
  const curatedReddit = curated.filter((c) => c.kind === "reddit").map((c) => c.value);
  const curatedTiktok = curated.filter((c) => c.kind === "tiktok").map((c) => c.value);
  const userThreads = (settings?.threadsHandles ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const userReddit = (settings?.redditSubs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const userTiktok = (settings?.tiktokHandles ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const mergedThreads = Array.from(new Set([...userThreads, ...curatedThreads]));
  const mergedReddit = Array.from(new Set([...userReddit, ...curatedReddit]));
  const mergedTiktok = Array.from(new Set([...userTiktok, ...curatedTiktok]));

  const canUseShared = !!user.canUseSharedLlm;

  // Decrypt secrets at read time. The DB stores them as enc:v2:<userId>:...
  // (or enc:v1 legacy / plaintext); readUserSecret routes to the right key
  // and writes a secret_access_log row for each call.
  const decGithub = await safeRead(userId, "githubToken", settings?.githubToken);
  const decPrimary = await safeRead(userId, "llmPrimaryApiKey", settings?.llmPrimaryApiKey);
  const decSensitive = await safeRead(userId, "llmSensitiveApiKey", settings?.llmSensitiveApiKey);
  const decDeepseek = await safeRead(userId, "deepseekApiKey", settings?.deepseekApiKey);
  const decAnthropic = await safeRead(userId, "anthropicApiKey", settings?.anthropicApiKey);

  // Prefer the generic-slot fields. Fall back to legacy columns so existing
  // rows keep working without forcing the user to re-enter keys.
  const primaryKey = decPrimary || decDeepseek || (canUseShared ? process.env.LLM_PRIMARY_API_KEY ?? process.env.DEEPSEEK_API_KEY : undefined) || undefined;
  const sensitiveKey = decSensitive || decAnthropic || (canUseShared ? process.env.LLM_SENSITIVE_API_KEY ?? process.env.ANTHROPIC_API_KEY : undefined) || undefined;

  return {
    userId,
    githubToken: decGithub || undefined,
    llmPrimaryApiKey: primaryKey,
    llmPrimaryBaseUrl: settings?.llmPrimaryBaseUrl || undefined,
    llmPrimaryModel: settings?.llmPrimaryModel || undefined,
    llmSensitiveApiKey: sensitiveKey,
    llmSensitiveBaseUrl: settings?.llmSensitiveBaseUrl || undefined,
    llmSensitiveModel: settings?.llmSensitiveModel || undefined,
    llmSensitiveWireFormat: settings?.llmSensitiveWireFormat || undefined,
    // Legacy mirrors. Filled with the same values so older callers (that
    // still set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY env vars) keep working.
    deepseekApiKey: primaryKey,
    anthropicApiKey: sensitiveKey,
    threadsHandles: mergedThreads.join(","),
    redditSubs: mergedReddit.join(","),
    tiktokHandles: mergedTiktok.join(","),
    emailToAddress: settings?.emailToAddress || process.env.EMAIL_TO_ADDRESS || undefined,
    detectedLanguages: settings?.detectedLanguages ?? null,
  };
}

async function safeRead(userId: number, column: string, stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  try {
    return await readUserSecret(userId, column, stored, "pipeline-run");
  } catch (e) {
    console.error(`[user-config] decrypt failed for user=${userId} column=${column}: ${(e as Error).message}`);
    return null;
  }
}
