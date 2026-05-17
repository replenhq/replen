// One-shot: run Stage-3's gh-targeted-search fetcher for one user and print
// what it would have returned. Does NOT insert into candidates — pure
// observation. Useful for validating the search vectors actually surface
// useful repos before letting the full pipeline ingest them.
//
// Usage:
//   tsx src/cli/inspect-targeted-search.ts --user=1
//   tsx src/cli/inspect-targeted-search.ts --user=1 --slug=nexus    (filter to one project)

import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { ghTargetedSearchFetcher } from "../fetchers/gh-targeted-search";
import { resolveUserConfig } from "../scheduler/user-config";
import { withRunConfig } from "../analyzer/run-context";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const userIdStr = arg("user");
  const slugFilter = arg("slug");
  if (!userIdStr) {
    console.error(`Usage: tsx src/cli/inspect-targeted-search.ts --user=<id> [--slug=<project-slug>]`);
    process.exit(1);
  }
  const userId = parseInt(userIdStr, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error(`Invalid --user=${userIdStr}`);
    process.exit(1);
  }

  // Defensive: tell the user how many vector-bearing projects we have so the
  // empty case ("no candidates") is interpretable.
  const projects = await db
    .select({ slug: schema.projectProfiles.slug, hasVectors: schema.projectProfiles.searchVectorsJson })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  const withVectors = projects.filter((p) => p.hasVectors).map((p) => p.slug);
  console.error(`[inspect-targeted] user=${userId} projects-with-vectors=[${withVectors.join(",") || "(none)"}]`);

  const cfg = await resolveUserConfig(userId);
  const candidates = await withRunConfig(
    {
      llmPrimaryApiKey: cfg.llmPrimaryApiKey,
      llmPrimaryBaseUrl: cfg.llmPrimaryBaseUrl,
      llmPrimaryModel: cfg.llmPrimaryModel,
      deepseekApiKey: cfg.deepseekApiKey,
      githubToken: cfg.githubToken,
    },
    () => ghTargetedSearchFetcher.run({ userId, detectedLanguages: null }),
  );

  const filtered = slugFilter
    ? candidates.filter((c) => c.source === `gh-targeted:${slugFilter}`)
    : candidates;

  // Compact human-readable output rather than dumping every candidate JSON.
  // Group by source (project slug) and show first ~5 repos per source.
  const bySource = new Map<string, typeof filtered>();
  for (const c of filtered) {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source)!.push(c);
  }

  if (bySource.size === 0) {
    console.error(`[inspect-targeted] no candidates returned`);
    return;
  }

  for (const [source, list] of bySource.entries()) {
    const projectSlug = source.replace(/^gh-targeted:/, "");
    console.log(`\n=== ${projectSlug} — ${list.length} candidates ===`);
    // Group by outcome within the source.
    const byOutcome = new Map<string, typeof list>();
    for (const c of list) {
      const o = (c.raw as { outcome?: string })?.outcome ?? "(no outcome)";
      if (!byOutcome.has(o)) byOutcome.set(o, []);
      byOutcome.get(o)!.push(c);
    }
    for (const [outcome, repos] of byOutcome.entries()) {
      console.log(`\n  outcome: ${outcome}`);
      for (const c of repos.slice(0, 5)) {
        const r = c.raw as { primaryLanguage?: string | null };
        const lang = r.primaryLanguage ?? "?";
        console.log(`    - ${c.sourceItemId} · ${c.score ?? 0}★ · ${lang}`);
        if (c.title) {
          const desc = c.title.slice(c.sourceItemId.length + 3).trim();
          if (desc) console.log(`      ${desc.slice(0, 200)}`);
        }
      }
      if (repos.length > 5) console.log(`    + ${repos.length - 5} more…`);
    }
  }

  console.log(`\n--- total: ${filtered.length} candidates`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
