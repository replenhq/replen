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
  let inserted = 0;
  let total = 0;
  const now = new Date();

  const ctx = { detectedLanguages: cfg.detectedLanguages ?? null, userId };

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
  return { inserted, total };
}
