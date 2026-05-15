import { db, schema } from "../db/client";
import { hnFetcher } from "./hn";
import { redditFetcher } from "./reddit";
import { ghTrendingFetcher } from "./gh-trending";
import { threadsFetcher } from "./threads";
import { tiktokFetcher } from "./tiktok";
import type { Fetcher } from "./types";
import type { UserConfig } from "../scheduler/user-config";

const FETCHERS: Fetcher[] = [hnFetcher, redditFetcher, ghTrendingFetcher, threadsFetcher, tiktokFetcher];

export async function runFetchers(userId: number, cfg: UserConfig): Promise<{ inserted: number; total: number }> {
  // Pump per-user config into env for the fetchers that read process.env directly.
  // Cleaner long-term: pass cfg through; for now this keeps the fetcher modules unchanged.
  const prev = {
    REDDIT_SUBS: process.env.REDDIT_SUBS,
    THREADS_HANDLES: process.env.THREADS_HANDLES,
    TIKTOK_HANDLES: process.env.TIKTOK_HANDLES,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  if (cfg.redditSubs) process.env.REDDIT_SUBS = cfg.redditSubs;
  if (cfg.threadsHandles) process.env.THREADS_HANDLES = cfg.threadsHandles;
  if (cfg.tiktokHandles) process.env.TIKTOK_HANDLES = cfg.tiktokHandles;
  if (cfg.deepseekApiKey) process.env.DEEPSEEK_API_KEY = cfg.deepseekApiKey;
  if (cfg.githubToken) process.env.GITHUB_TOKEN = cfg.githubToken;

  let inserted = 0;
  let total = 0;
  const now = new Date();

  const ctx = { detectedLanguages: cfg.detectedLanguages ?? null };

  try {
    for (const f of FETCHERS) {
      let items: Awaited<ReturnType<Fetcher["run"]>> = [];
      try {
        items = await f.run(ctx);
        console.log(`[fetch] user=${userId} ${f.name}: ${items.length} items`);
      } catch (e) {
        console.error(`[fetch] ${f.name} failed`, e);
        continue;
      }
      total += items.length;
      for (const it of items) {
        try {
          const result = await db
            .insert(schema.candidates)
            .values({
              userId,
              source: it.source,
              sourceItemId: it.sourceItemId,
              title: it.title,
              url: it.url,
              githubUrl: it.githubUrl,
              author: it.author,
              score: it.score,
              postedAt: it.postedAt,
              fetchedAt: now,
              rawJson: JSON.stringify(it.raw),
            })
            .onConflictDoNothing({ target: [schema.candidates.userId, schema.candidates.source, schema.candidates.sourceItemId] });
          if (result.rowsAffected > 0) inserted++;
        } catch (e) {
          console.warn(`[fetch] insert failed for ${it.source}:${it.sourceItemId}`, e);
        }
      }
    }
  } finally {
    // Restore env so concurrent runs don't bleed config.
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { inserted, total };
}
