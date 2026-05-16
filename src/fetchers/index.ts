import { db, schema } from "../db/client";
import { hnFetcher } from "./hn";
import { redditFetcher } from "./reddit";
import { ghTrendingFetcher } from "./gh-trending";
import { ghSearchFetcher } from "./gh-search";
import { threadsFetcher } from "./threads";
import { tiktokFetcher } from "./tiktok";
import type { Fetcher } from "./types";
import type { UserConfig } from "../scheduler/user-config";
import { withRunConfig } from "../analyzer/run-context";

const FETCHERS: Fetcher[] = [hnFetcher, redditFetcher, ghTrendingFetcher, ghSearchFetcher, threadsFetcher, tiktokFetcher];

export async function runFetchers(userId: number, cfg: UserConfig): Promise<{ inserted: number; total: number }> {
  return withRunConfig(
    {
      llmPrimaryApiKey: cfg.llmPrimaryApiKey,
      llmPrimaryBaseUrl: cfg.llmPrimaryBaseUrl,
      llmPrimaryModel: cfg.llmPrimaryModel,
      deepseekApiKey: cfg.deepseekApiKey,
      githubToken: cfg.githubToken,
      redditSubs: cfg.redditSubs,
      threadsHandles: cfg.threadsHandles,
      tiktokHandles: cfg.tiktokHandles,
    },
    () => runFetchersInner(userId, cfg)
  );
}

async function runFetchersInner(userId: number, cfg: UserConfig): Promise<{ inserted: number; total: number }> {
  const now = new Date();
  const ctx = { detectedLanguages: cfg.detectedLanguages ?? null, userId };

  // Fetchers are independent; run them in parallel so a slow one (threads)
  // doesn't block the rest. Each failure is isolated.
  const results = await Promise.all(
    FETCHERS.map(async (f) => {
      try {
        const items = await f.run(ctx);
        console.log(`[fetch] user=${userId} ${f.name}: ${items.length} items`);
        return items;
      } catch (e) {
        console.error(`[fetch] ${f.name} failed`, e);
        return [];
      }
    })
  );
  const items = results.flat();
  const total = items.length;
  if (total === 0) return { inserted: 0, total: 0 };

  // Single batched insert per run. SQLite ON CONFLICT DO NOTHING handles
  // duplicate (userId, source, sourceItemId) tuples cheaply.
  const rows = items.map((it) => ({
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
  }));
  let inserted = 0;
  try {
    const result = await db
      .insert(schema.candidates)
      .values(rows)
      .onConflictDoNothing({ target: [schema.candidates.userId, schema.candidates.source, schema.candidates.sourceItemId] });
    inserted = result.rowsAffected;
  } catch (e) {
    console.warn(`[fetch] batch insert failed; falling back to per-row`, e);
    for (const row of rows) {
      try {
        const r = await db
          .insert(schema.candidates)
          .values(row)
          .onConflictDoNothing({ target: [schema.candidates.userId, schema.candidates.source, schema.candidates.sourceItemId] });
        if (r.rowsAffected > 0) inserted++;
      } catch (err) {
        console.warn(`[fetch] insert failed for ${row.source}:${row.sourceItemId}`, err);
      }
    }
  }
  return { inserted, total };
}
