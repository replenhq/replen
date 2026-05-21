// One-shot backfill: populate primary_language / topics / repo_shape on
// existing candidates rows where the data is recoverable from raw_json
// or the linked repos row.
//
// Idempotent: rows that already have primary_language set are skipped.
//
// Run:
//   npx tsx src/scheduler/backfill-candidate-inventory.ts
//
// Designed to run inline (no concurrency) — the candidates table is
// small enough (~thousands) that this finishes in seconds.

import { db, schema } from "../db/client";
import { eq, isNull, or } from "drizzle-orm";
import { inferRepoShape } from "../fetchers/repo-shape";

type RawShape = {
  desc?: string;
  description?: string;
  name?: string;
  lang?: string;
  language?: string;
  primaryLanguage?: string;
  topics?: unknown;
};

function parseRaw(raw: string | null): RawShape {
  if (!raw) return {};
  try { return JSON.parse(raw) as RawShape; } catch { return {}; }
}

function extractTopics(raw: RawShape): string[] | null {
  if (!raw.topics) return null;
  if (Array.isArray(raw.topics)) {
    return raw.topics.filter((t): t is string => typeof t === "string");
  }
  return null;
}

async function backfill(): Promise<{ scanned: number; updated: number }> {
  // Match rows that haven't been tagged yet. Either column being null is
  // a sufficient signal — primaryLanguage is the cheapest to check and
  // is also the most common gap.
  const rows = await db
    .select({
      id: schema.candidates.id,
      githubUrl: schema.candidates.githubUrl,
      title: schema.candidates.title,
      rawJson: schema.candidates.rawJson,
      currentLang: schema.candidates.primaryLanguage,
      currentShape: schema.candidates.repoShape,
    })
    .from(schema.candidates)
    .where(or(
      isNull(schema.candidates.primaryLanguage),
      isNull(schema.candidates.repoShape),
    ));

  console.log(`[backfill] scanning ${rows.length} untagged candidates`);

  let updated = 0;
  for (const r of rows) {
    const raw = parseRaw(r.rawJson);
    const description = raw.description ?? raw.desc ?? "";
    const name = raw.name ?? (r.title ? r.title.split("/")[1]?.split(" -")[0]?.trim() : "") ?? "";
    const language = raw.primaryLanguage ?? raw.language ?? raw.lang ?? null;
    const topics = extractTopics(raw);
    const shape = inferRepoShape({ name, description, topics });

    // Try to enrich language from the linked `repos` row when raw didn't
    // include it. Only when we have a githubUrl to join on.
    let enrichedLang = language;
    if (!enrichedLang && r.githubUrl) {
      const repo = await db
        .select({ primaryLanguage: schema.repos.primaryLanguage })
        .from(schema.repos)
        .where(eq(schema.repos.url, r.githubUrl))
        .get();
      if (repo?.primaryLanguage) enrichedLang = repo.primaryLanguage;
    }

    const next = {
      primaryLanguage: enrichedLang || null,
      topics: topics && topics.length > 0 ? JSON.stringify(topics) : null,
      repoShape: shape,
    };
    // Skip if nothing actually changed (both null + unknown = nothing
    // worth writing).
    if (!next.primaryLanguage && !next.topics && next.repoShape === "unknown" && !r.currentLang && !r.currentShape) continue;
    await db.update(schema.candidates).set(next).where(eq(schema.candidates.id, r.id));
    updated++;
  }

  console.log(`[backfill] done: ${updated}/${rows.length} updated`);
  return { scanned: rows.length, updated };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await backfill();
  process.exit(0);
}

export { backfill };
