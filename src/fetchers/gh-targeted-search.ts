// Stage 3: targeted GitHub search. Reads each project's persisted
// ProjectSearchVectors (from Stage 2), runs ONE GitHub search per vector,
// and produces candidates tagged with the originating project + outcome.
// See docs/stage-2-scope.md for the upstream contract, and
// docs/active-scouting-plan.md for where this fits.
//
// Key differences from gh-search.ts:
//   - gh-search builds queries from a project's `searchKeywords` (a flat
//     list of topic-like terms derived once from the docs). It's a broad
//     "stuff in your area" sweep.
//   - gh-targeted-search builds queries from per-outcome search vectors
//     produced by the Stage-2 LLM. Each query is tied to a specific
//     outcome goal the user actually said they care about. Candidates
//     carry that attribution forward to Stage 4 (and onward to the UI:
//     "this match surfaced because you said you want X").

import type { Fetcher, FetchedCandidate, FetcherContext } from "./types";
import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { readRunOrEnv } from "../analyzer/run-context";
import { shouldSkip } from "./big-co";
import type { ProjectSearchVectors, SearchVector } from "../projects/search-vectors";

// Conservative caps.
const PER_VECTOR_RESULTS = parseInt(process.env.GH_TARGETED_PER_VECTOR ?? "6", 10);
const FRESHNESS_DAYS = parseInt(process.env.GH_TARGETED_FRESHNESS_DAYS ?? "365", 10);
const MIN_STARS = parseInt(process.env.GH_TARGETED_MIN_STARS ?? "30", 10);
// Budget across the user's whole run. GitHub authenticated search is
// 30 req/min, so 20 leaves headroom for other fetchers (gh-search uses some).
const PER_USER_SEARCH_BUDGET = parseInt(process.env.GH_TARGETED_BUDGET ?? "20", 10);
// Skip projects without included=true OR active=true.
const MAX_PROJECTS = parseInt(process.env.GH_TARGETED_MAX_PROJECTS ?? "10", 10);

export const ghTargetedSearchFetcher: Fetcher = {
  name: "gh-targeted",
  async run(ctx?: FetcherContext): Promise<FetchedCandidate[]> {
    if (!ctx?.userId) return [];
    const userId = ctx.userId;

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
    if (projects.length === 0) return [];

    const targetProjects = projects.slice(0, MAX_PROJECTS);
    const pushedAfter = isoDateNDaysAgo(FRESHNESS_DAYS);
    const out: FetchedCandidate[] = [];
    const seenOwnerName = new Set<string>(); // dedupe across vectors within this run
    let budgetRemaining = PER_USER_SEARCH_BUDGET;

    const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "replen/0.1",
    };
    if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

    for (const project of targetProjects) {
      if (budgetRemaining <= 0) {
        console.warn(`[gh-targeted] user=${userId} search budget exhausted; remaining projects skipped`);
        break;
      }
      if (!project.searchVectorsJson) continue;

      let parsed: ProjectSearchVectors;
      try {
        parsed = JSON.parse(project.searchVectorsJson) as ProjectSearchVectors;
      } catch {
        console.warn(`[gh-targeted] user=${userId} ${project.slug}: malformed search_vectors_json`);
        continue;
      }
      if (!parsed.vectors?.length) continue;

      for (const vector of parsed.vectors) {
        if (budgetRemaining <= 0) break;
        const q = buildQuery(vector, pushedAfter);
        if (!q) continue;
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PER_VECTOR_RESULTS}`;

        budgetRemaining--;
        let items: Array<Record<string, unknown>> = [];
        try {
          const res = await fetch(url, { headers });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.warn(`[gh-targeted] ${project.slug} "${vector.outcome.slice(0, 50)}…": HTTP ${res.status} ${body.slice(0, 200)}`);
            continue;
          }
          const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
          items = json.items ?? [];
        } catch (e) {
          console.warn(`[gh-targeted] ${project.slug}: fetch failed`, e);
          continue;
        }

        let kept = 0;
        for (const item of items) {
          const fullName = String(item.full_name ?? "");
          const [owner, name] = fullName.split("/");
          if (!owner || !name) continue;
          // Dedupe within this run — same repo surfacing for multiple outcomes
          // would inflate Stage-4's workload without adding signal.
          if (seenOwnerName.has(fullName)) continue;
          const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
          const verdict = shouldSkip(owner, stars);
          if (verdict.skip) continue;
          seenOwnerName.add(fullName);

          const description = String(item.description ?? "").trim();
          const pushedAt = item.pushed_at ? new Date(String(item.pushed_at)) : null;
          const primaryLanguage = typeof item.language === "string" ? item.language : null;

          out.push({
            source: `gh-targeted:${project.slug}`,
            sourceItemId: fullName,
            title: `${fullName} - ${description}`.slice(0, 280),
            url: `https://github.com/${fullName}`,
            githubUrl: `https://github.com/${fullName}`,
            author: owner,
            score: stars,
            postedAt: pushedAt,
            // Attribution carried into raw for Stage 4 + UI:
            //   - which project surfaced this
            //   - which outcome statement (verbatim, lifted from summary)
            //   - source/confidence of the originating outcome
            //   - the actual query that hit GitHub (debugging)
            raw: {
              owner,
              name,
              description,
              stars,
              primaryLanguage,
              projectSlug: project.slug,
              projectId: project.id,
              outcome: vector.outcome,
              outcomeSource: vector.outcomeSource,
              outcomeConfidence: vector.outcomeConfidence,
              query: q,
            },
          });
          kept++;
        }
        console.log(`[gh-targeted] user=${userId} ${project.slug} "${vector.outcome.slice(0, 60)}…": ${kept} kept (q="${q.slice(0, 120)}…")`);
      }
    }

    console.log(`[gh-targeted] user=${userId} done; ${out.length} candidates from ${PER_USER_SEARCH_BUDGET - budgetRemaining} searches`);
    return out;
  },
};

// Build a single GitHub search query for one vector. Returns null when the
// vector has no usable query terms (defensive — Stage 2 should have filtered
// these out, but we don't trust upstream).
//
// Query shape: `(t1 OR "phrase 2" OR "phrase 3") pushed:>YYYY-MM-DD stars:>=N archived:false language:X`
// - Single-word terms are bare (allows GitHub to match in name/desc/topics)
// - Multi-word terms are quoted (treated as a phrase)
// - Language constraint: GitHub search ANDs `language:X` so multi-language
//   constraints require multiple queries. Conservative-first: pick the FIRST
//   language. We can broaden later if Stage 4 rejects valid cross-language
//   candidates often.
export function buildQuery(vector: SearchVector, pushedAfter: string): string | null {
  const terms = vector.queryTerms
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 80)
    .slice(0, 4);
  if (terms.length === 0) return null;

  // Wrap multi-word terms in quotes so GitHub treats them as a phrase.
  // Strip any quote chars the LLM might have left in.
  const wrapped = terms.map((t) => {
    const clean = t.replace(/["']/g, "").trim();
    return /\s/.test(clean) ? `"${clean}"` : clean;
  });
  const orClause = wrapped.length === 1 ? wrapped[0] : `(${wrapped.join(" OR ")})`;

  let q = `${orClause} pushed:>${pushedAfter} stars:>=${MIN_STARS} archived:false`;
  if (vector.languageConstraint && vector.languageConstraint.length > 0) {
    // Take the first allowed language. See note above on why this is
    // conservative-first.
    q += ` language:${vector.languageConstraint[0]}`;
  }
  // GitHub search has a 256-char limit on q; truncate defensively if we
  // somehow blew it (shouldn't happen with our caps).
  return q.length > 250 ? q.slice(0, 250) : q;
}

function isoDateNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
