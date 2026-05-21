import { db, schema } from "../db/client";
import { errorMsg } from "../lib/error-msg";
import { hnFetcher } from "./hn";
import { redditFetcher } from "./reddit";
import { ghTrendingFetcher } from "./gh-trending";
import { ossinsightTrendingFetcher } from "./ossinsight-trending";
import { ghSearchFetcher } from "./gh-search";
import { ghSearchRecentFetcher } from "./gh-search-recent";
import { ghTargetedSearchFetcher } from "./gh-targeted-search";
import { historicalSearchFetcher } from "./historical-search";
import { threadsFetcher } from "./threads";
import { tiktokFetcher } from "./tiktok";
import type { Fetcher } from "./types";
import type { UserConfig } from "../scheduler/user-config";
import { withRunConfig } from "../analyzer/run-context";

const FETCHERS: Fetcher[] = [hnFetcher, redditFetcher, ghTrendingFetcher, ossinsightTrendingFetcher, ghSearchFetcher, ghSearchRecentFetcher, ghTargetedSearchFetcher, historicalSearchFetcher, threadsFetcher, tiktokFetcher];

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
        // Audit L9: pass an error MESSAGE not the raw Error object. Some
        // undici error shapes carry request headers (incl. Authorization)
        // which would land in logs via the default util.inspect path.
        console.error(`[fetch] ${f.name} failed: ${errorMsg(e)}`);
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
    // Pipeline v2 / Sprint 1 inventory fields. Null is fine — Stage 2
    // treats unknowns as deferring to the LLM tier rather than as a
    // hard block.
    primaryLanguage: it.primaryLanguage ?? null,
    topics: it.topics ? JSON.stringify(it.topics) : null,
    repoShape: it.repoShape ?? null,
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
