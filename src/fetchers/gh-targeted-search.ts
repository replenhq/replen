// Stage 3: targeted GitHub search. Reads each project's persisted
// ProjectSearchVectors (from Stage 2), runs one GitHub search per query
// term within each vector, and produces candidates tagged with the
// originating project + outcome + which specific term matched.
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
import type { ProjectSearchVectors } from "../projects/search-vectors";
import { uncoveredWaypoints } from "../graph/coverage";

// Conservative caps.
const PER_TERM_RESULTS = parseInt(process.env.GH_TARGETED_PER_TERM ?? "5", 10);
const FRESHNESS_DAYS = parseInt(process.env.GH_TARGETED_FRESHNESS_DAYS ?? "365", 10);
const MIN_STARS = parseInt(process.env.GH_TARGETED_MIN_STARS ?? "30", 10);
// Budget across the user's whole run. GitHub authenticated search is
// 30 req/min, so 25 leaves headroom for other fetchers (gh-search uses some).
const PER_USER_SEARCH_BUDGET = parseInt(process.env.GH_TARGETED_BUDGET ?? "25", 10);
// Cap how many projects we hit per run. With per-term queries the budget
// gets eaten fast — 3 vectors × 3 terms = 9 queries/project. Adjust upward
// only when budget allows.
const MAX_PROJECTS = parseInt(process.env.GH_TARGETED_MAX_PROJECTS ?? "10", 10);
// Blind-spot scouting: uncovered WAYPOINT capabilities (no candidate has ever
// been evaluated against them — see src/graph/coverage.ts) each get one
// search per run, after the outcome vectors have spent their budget share.
const BLINDSPOT_MAX = Math.max(0, parseInt(process.env.GH_TARGETED_BLINDSPOTS ?? "3", 10) || 3);

export const ghTargetedSearchFetcher: Fetcher = {
  name: "gh-targeted",
  async run(ctx?: FetcherContext): Promise<FetchedCandidate[]> {
    if (!ctx?.userId) return [];
    const userId = ctx.userId;

    // Note: we filter on `included` but NOT on `active`. The `active` flag is
    // set by the loader based on CLAUDE.md presence; Stage-3 only fires when
    // a project has actual search vectors (gated by Stage 2's conservative
    // bias), which is itself proof the project has high-confidence outcome
    // goals — a stronger signal than "has a CLAUDE.md file". So vectors-exist
    // is the new gate.
    const projects = await db
      .select()
      .from(schema.projectProfiles)
      .where(
        and(
          eq(schema.projectProfiles.userId, userId),
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

        // One search per term. Earlier design used a single OR-joined query
        // per vector, but GitHub's repo search parser handles multi-word OR
        // unpredictably (4×2-word OR returns 0 for some term orderings while
        // 2×2-word OR with the same terms returns 100+). Per-term queries
        // have predictable semantics: each is an implicit-AND match.
        let keptForVector = 0;
        const queriesForVector: string[] = [];
        for (const term of vector.queryTerms) {
          if (budgetRemaining <= 0) break;
          const q = buildSingleTermQuery(term, vector.languageConstraint, pushedAfter);
          if (!q) continue;
          queriesForVector.push(q);
          const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PER_TERM_RESULTS}`;

          budgetRemaining--;
          let items: Array<Record<string, unknown>> = [];
          try {
            const res = await fetch(url, { headers });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              console.warn(`[gh-targeted] ${project.slug} "${term}": HTTP ${res.status} ${body.slice(0, 200)}`);
              continue;
            }
            const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
            items = json.items ?? [];
          } catch (e) {
            console.warn(`[gh-targeted] ${project.slug} "${term}": fetch failed`, e);
            continue;
          }

          for (const item of items) {
            const fullName = String(item.full_name ?? "");
            const [owner, name] = fullName.split("/");
            if (!owner || !name) continue;
            // Dedupe within this run — same repo surfacing for multiple terms
            // or outcomes shouldn't multiply Stage-4's workload.
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
              //   - which specific term hit (for debugging poorly-performing terms)
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
                matchedTerm: term,
                query: q,
              },
            });
            keptForVector++;
          }
        }
        console.log(`[gh-targeted] user=${userId} ${project.slug} "${vector.outcome.slice(0, 60)}…": ${keptForVector} kept across ${queriesForVector.length} terms`);
      }
    }

    // GOAL scouting — what the user said they WANT to build searches FIRST
    // (a stated goal outranks an inferred gap for budget).
    if (budgetRemaining > 0) {
      const goals = await db.select().from(schema.capabilityGoals)
        .where(and(eq(schema.capabilityGoals.userId, userId), eq(schema.capabilityGoals.status, "active")))
        .limit(3);
      for (const goal of goals) {
        if (budgetRemaining <= 0) break;
        const q = buildSingleTermQuery(goal.label, null, pushedAfter);
        if (!q) continue;
        budgetRemaining--;
        let items: Array<Record<string, unknown>> = [];
        try {
          const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PER_TERM_RESULTS}`, { headers });
          if (!res.ok) { console.warn(`[gh-targeted] goal "${goal.label}": HTTP ${res.status}`); continue; }
          items = ((await res.json()) as { items?: Array<Record<string, unknown>> }).items ?? [];
        } catch (e) {
          console.warn(`[gh-targeted] goal "${goal.label}": fetch failed`, e);
          continue;
        }
        let kept = 0;
        const attributionSlug = goal.projectSlug ?? projects[0]?.slug;
        if (!attributionSlug) break;
        for (const item of items) {
          const fullName = String(item.full_name ?? "");
          const [owner, name] = fullName.split("/");
          if (!owner || !name || seenOwnerName.has(fullName)) continue;
          const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
          if (shouldSkip(owner, stars).skip) continue;
          seenOwnerName.add(fullName);
          out.push({
            source: `gh-targeted:${attributionSlug}`,
            sourceItemId: fullName,
            title: `${fullName} - ${String(item.description ?? "").trim()}`.slice(0, 280),
            url: `https://github.com/${fullName}`,
            githubUrl: `https://github.com/${fullName}`,
            author: owner,
            score: stars,
            postedAt: item.pushed_at ? new Date(String(item.pushed_at)) : null,
            raw: {
              owner, name,
              description: String(item.description ?? "").trim(),
              stars,
              primaryLanguage: typeof item.language === "string" ? item.language : null,
              projectSlug: attributionSlug,
              outcome: `user goal: ${goal.label}${goal.descriptor ? ` — ${goal.descriptor}` : ""}`,
              outcomeSource: "user-goal",
              outcomeConfidence: "high",
              matchedTerm: goal.label,
              query: q,
              goalId: goal.id,
            },
          });
          kept++;
        }
        console.log(`[gh-targeted] user=${userId} goal "${goal.label}": ${kept} kept`);
      }
    }

    // Blind-spot scouting — coverage feeding acquisition. Uncovered waypoint
    // capabilities get one search each with the remaining budget; candidates
    // attribute to the first project that has the capability so downstream
    // scoring/eligibility treat them like any other targeted result.
    if (budgetRemaining > 0 && BLINDSPOT_MAX > 0) {
      let spots: Awaited<ReturnType<typeof uncoveredWaypoints>> = [];
      try {
        spots = await uncoveredWaypoints(userId, BLINDSPOT_MAX);
      } catch (e) {
        console.warn(`[gh-targeted] user=${userId} blind-spot lookup failed:`, e);
      }
      for (const spot of spots) {
        if (budgetRemaining <= 0) break;
        const q = buildSingleTermQuery(spot.label, null, pushedAfter);
        if (!q) continue;
        budgetRemaining--;
        let items: Array<Record<string, unknown>> = [];
        try {
          const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PER_TERM_RESULTS}`, { headers });
          if (!res.ok) {
            console.warn(`[gh-targeted] blind spot "${spot.label}": HTTP ${res.status}`);
            continue;
          }
          items = ((await res.json()) as { items?: Array<Record<string, unknown>> }).items ?? [];
        } catch (e) {
          console.warn(`[gh-targeted] blind spot "${spot.label}": fetch failed`, e);
          continue;
        }
        let kept = 0;
        for (const item of items) {
          const fullName = String(item.full_name ?? "");
          const [owner, name] = fullName.split("/");
          if (!owner || !name || seenOwnerName.has(fullName)) continue;
          const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
          if (shouldSkip(owner, stars).skip) continue;
          seenOwnerName.add(fullName);
          out.push({
            source: `gh-targeted:${spot.projectSlugs[0]}`,
            sourceItemId: fullName,
            title: `${fullName} - ${String(item.description ?? "").trim()}`.slice(0, 280),
            url: `https://github.com/${fullName}`,
            githubUrl: `https://github.com/${fullName}`,
            author: owner,
            score: stars,
            postedAt: item.pushed_at ? new Date(String(item.pushed_at)) : null,
            raw: {
              owner, name,
              description: String(item.description ?? "").trim(),
              stars,
              primaryLanguage: typeof item.language === "string" ? item.language : null,
              projectSlug: spot.projectSlugs[0],
              outcome: `coverage blind spot: nothing has ever been evaluated against "${spot.label}" (a waypoint capability)`,
              outcomeSource: "graph-coverage",
              outcomeConfidence: "medium",
              matchedTerm: spot.label,
              query: q,
              blindspot: true,
            },
          });
          kept++;
        }
        console.log(`[gh-targeted] user=${userId} blind spot "${spot.label}": ${kept} kept (projects: ${spot.projectSlugs.join(", ")})`);
      }
    }

    console.log(`[gh-targeted] user=${userId} done; ${out.length} candidates from ${PER_USER_SEARCH_BUDGET - budgetRemaining} searches`);
    return out;
  },
};

// Build a single GitHub search query for ONE term. Returns null if the term
// is empty after cleaning.
//
// Query shape: `term words pushed:>YYYY-MM-DD stars:>=N archived:false language:X`
// - Multi-word terms stay unquoted so GitHub treats them as implicit-AND
//   tokens against repo name/description/topics. Quoted phrases ("drift
//   detection") almost never match repo metadata; unquoted (drift detection)
//   means "both words somewhere in metadata" which is what we want.
// - Language constraint: GitHub search ANDs `language:X` so multi-language
//   constraints require multiple queries. Conservative-first: pick the FIRST
//   language. We can broaden later if Stage 4 rejects valid cross-language
//   candidates often.
export function buildSingleTermQuery(
  term: string,
  languageConstraint: string[] | null,
  pushedAfter: string,
): string | null {
  const clean = term.replace(/["']/g, "").trim();
  if (clean.length < 2 || clean.length > 80) return null;
  let q = `${clean} pushed:>${pushedAfter} stars:>=${MIN_STARS} archived:false`;
  if (languageConstraint && languageConstraint.length > 0) {
    q += ` language:${languageConstraint[0]}`;
  }
  return q.length > 250 ? q.slice(0, 250) : q;
}

function isoDateNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
