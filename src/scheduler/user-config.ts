// Resolves the configuration for a pipeline run for a given user.
// - User-set values always win.
// - Env-var fallback for LLM keys is GATED on users.canUseSharedLlm (admin grants it).
// - GitHub token: BYO only (never shared) — leaks attribute API calls to the user.
// - Email destination: per-user; falls back to env so admin keeps working.

import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { decryptSecret } from "../lib/crypto";

export type UserConfig = {
  userId: number;
  githubToken: string | undefined;
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

  // Decrypt secrets at read time. The DB stores them as enc:v1:... (or
  // plaintext for pre-migration rows); the pipeline downstream only sees
  // raw values.
  const decGithub = settings?.githubToken ? safeDec(settings.githubToken) : null;
  const decDeepseek = settings?.deepseekApiKey ? safeDec(settings.deepseekApiKey) : null;
  const decAnthropic = settings?.anthropicApiKey ? safeDec(settings.anthropicApiKey) : null;

  return {
    userId,
    // GitHub token: BYO. Never shared.
    githubToken: decGithub || undefined,
    // LLM keys: user's own first, else shared (only if granted).
    deepseekApiKey: decDeepseek || (canUseShared ? process.env.DEEPSEEK_API_KEY : undefined) || undefined,
    anthropicApiKey: decAnthropic || (canUseShared ? process.env.ANTHROPIC_API_KEY : undefined) || undefined,
    threadsHandles: mergedThreads.join(","),
    redditSubs: mergedReddit.join(","),
    tiktokHandles: mergedTiktok.join(","),
    emailToAddress: settings?.emailToAddress || process.env.EMAIL_TO_ADDRESS || undefined,
    detectedLanguages: settings?.detectedLanguages ?? null,
  };
}

function safeDec(stored: string): string | null {
  try {
    return decryptSecret(stored);
  } catch (e) {
    console.error(`[user-config] decrypt failed: ${(e as any)?.message ?? e}`);
    return null;
  }
}
