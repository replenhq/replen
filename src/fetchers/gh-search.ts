import type { Fetcher, FetchedCandidate, FetcherContext } from "./types";
import { db, schema } from "../db/client";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { deriveSearchKeywords } from "../analyzer/keywords";
import { shouldSkip } from "./big-co";
import { readRunOrEnv } from "../analyzer/run-context";

// Niche-aware GitHub repo search. For each of the user's active project
// profiles, derive (and cache) 3-5 search keywords from the project's docs,
// then query GitHub's /search/repositories for recently-pushed repos
// matching those keywords. Results are tagged with source="gh-search:<slug>"
// so the source-ranking pipeline can weight them per-project.
//
// Why this exists: gh-trending is a coarse firehose - good for the broad
// ecosystem view, but blind to anything outside the daily top-25 per
// language. A project working on, say, image-segmentation will see the
// monthly trending top-25 from gh-trending, but never the new 80-star
// segmentation repo that landed last week. This fetcher closes that gap.

const PER_PROJECT_CAP = parseInt(process.env.GH_SEARCH_PER_PROJECT ?? "8", 10);
const FRESHNESS_DAYS = parseInt(process.env.GH_SEARCH_FRESHNESS_DAYS ?? "21", 10);
const MIN_STARS = parseInt(process.env.GH_SEARCH_MIN_STARS ?? "30", 10);
const MAX_PROJECTS = parseInt(process.env.GH_SEARCH_MAX_PROJECTS ?? "10", 10);

export const ghSearchFetcher: Fetcher = {
  name: "gh-search",
  async run(ctx?: FetcherContext): Promise<FetchedCandidate[]> {
    if (!ctx?.userId) {
      console.log("[gh-search] no userId in context; skipping");
      return [];
    }
    const userId = ctx.userId;

    // Active + included projects only. Order by ID so re-runs are stable.
    const projects = await db
      .select()
      .from(schema.projectProfiles)
      .where(
        and(
          eq(schema.projectProfiles.userId, userId),
          eq(schema.projectProfiles.active, true),
          eq(schema.projectProfiles.included, true),
        ),
      )
      .orderBy(schema.projectProfiles.id);

    if (projects.length === 0) {
      console.log(`[gh-search] user=${userId} no active+included projects; skipping`);
      return [];
    }

    const targetProjects = projects.slice(0, MAX_PROJECTS);
    const pushedAfter = isoDateNDaysAgo(FRESHNESS_DAYS);
    const out: FetchedCandidate[] = [];

    for (const project of targetProjects) {
      // Lazy keyword derivation: first run for the project, or after the
      // profileHash changed (loader nulls search_keywords on hash change).
      let keywords = project.searchKeywords;
      if (!keywords) {
        console.log(`[gh-search] user=${userId} deriving keywords for ${project.slug}`);
        keywords = await deriveSearchKeywords({
          slug: project.slug,
          name: project.name,
          readmeMd: project.readmeMd,
          claudeMd: project.claudeMd,
          techSummary: project.techSummary,
        });
        if (!keywords) {
          console.log(`[gh-search] user=${userId} ${project.slug}: no keywords derivable, skipping`);
          continue;
        }
        await db
          .update(schema.projectProfiles)
          .set({ searchKeywords: keywords })
          .where(eq(schema.projectProfiles.id, project.id));
      }

      const tokens = keywords.split(",").map((t) => t.trim()).filter(Boolean);
      if (tokens.length === 0) continue;

      // Build the search query: OR across keywords, restrict to recently
      // pushed and reasonably popular repos. `topic:foo OR keyword` widens
      // recall when the maintainer hasn't tagged the repo with a topic.
      const orClause = tokens.map((t) => `topic:${t} OR "${t.replace(/-/g, " ")}"`).join(" OR ");
      const q = `(${orClause}) pushed:>${pushedAfter} stars:>=${MIN_STARS}`;
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PER_PROJECT_CAP}`;

      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "replen/0.1",
      };
      const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
      if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

      let items: Array<Record<string, unknown>> = [];
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.warn(`[gh-search] ${project.slug}: HTTP ${res.status} ${body.slice(0, 200)}`);
          continue;
        }
        const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
        items = json.items ?? [];
      } catch (e) {
        console.warn(`[gh-search] ${project.slug}: fetch failed`, e);
        continue;
      }

      let kept = 0;
      for (const item of items) {
        const fullName = String(item.full_name ?? "");
        const [owner, name] = fullName.split("/");
        if (!owner || !name) continue;
        const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
        const verdict = shouldSkip(owner, stars);
        if (verdict.skip) continue;
        const description = String(item.description ?? "").trim();
        const pushedAt = item.pushed_at ? new Date(String(item.pushed_at)) : null;
        out.push({
          source: `gh-search:${project.slug}`,
          sourceItemId: fullName,
          title: `${fullName} - ${description}`.slice(0, 280),
          url: `https://github.com/${fullName}`,
          githubUrl: `https://github.com/${fullName}`,
          author: owner,
          score: stars,
          postedAt: pushedAt,
          raw: { owner, name, description, stars, query: q, projectSlug: project.slug },
        });
        kept++;
      }
      console.log(`[gh-search] user=${userId} ${project.slug}: ${kept} kept (q="${q.slice(0, 120)}")`);
    }

    return out;
  },
};

function isoDateNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// `sql` import retained for tree-shake safety on stricter bundlers.
void sql;
void isNotNull;
