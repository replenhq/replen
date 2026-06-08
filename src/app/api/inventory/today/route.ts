import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { checkEligibility } from "@/analyzer/eligibility";
import type { RepoShape } from "@/fetchers/repo-shape";
import { cosineSimilarity, parseStoredEmbedding, parseStoredFacetEmbeddings, type FacetEmbedding } from "@/lib/embeddings";
import { globalDemoteThresholds, isGloballyDemoted } from "@/lib/repo-quality";
import { findSimilarProjectPromotions } from "@/lib/cross-user-promote";
import { parseTechSummaryDeps } from "@/fetchers/stack-watch/registry";

// Skill-mode inventory endpoint.
//
// What this is NOT: the legacy /api/mcp/today, which returned LLM-
// scored matches with writeups produced by the hosted pipeline. This
// returns raw candidates from the inventory, lightly filtered, with
// NO LLM output — the calling skill produces writeups in-session
// using the user's subscription tokens.
//
// What this IS: a per-user, filter-mode-aware view of the last N days
// of fetched candidates. Three filter modes:
//   - 'zero-knowledge': passthrough (full firehose). Most private.
//     User opts in to send Replen literally nothing about their
//     projects beyond a DIGEST_TOKEN for identity.
//   - 'tags' (default): intersect candidate
//     primaryLanguage/topics with the user's project_profiles.tags
//     JSON array. Tags are user-curated metadata, not source code.
//   - 'fingerprint': similarity-based pre-filter using the project's
//     LSH-style shape hash. Sharpest pre-filter; explicit opt-in.
//     v1: not yet implemented — falls back to 'tags' behaviour.
//
// Exclusion of user-state: candidates whose repo already has a
// user_match_state row of 'starred', 'hidden', or 'handed_off' for
// this user are silently excluded. The skill never re-surfaces what
// the user has already engaged with (or actively dismissed).
//
// Returns: an ordered list of candidates with repo metadata + a
// cheap server-derived `whyShortlisted` line. The skill ranks and
// writes up these candidates in-session — that's the whole point.
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);
  const repoFilter = url.searchParams.get("repo")?.trim().toLowerCase() || null;

  // Adaptive lookback window. An explicit ?days= wins (clamped 1..365).
  // Otherwise the window adapts to the SCOPED PROJECT's history (computed
  // after scope resolves below): a project that has never surfaced a match
  // the user engaged with gets a wide FIRST-RUN window so its very first
  // match has months of inventory to pull from — the good per-project
  // `gh-targeted:*` candidates are often days-to-weeks old and a narrow
  // window amputates them, making the matcher look empty/broken. A project
  // that's already surfaced matches gets the steady ~month window so the
  // footnote stays "what's new" rather than re-litigating old candidates.
  // Both are env-tunable.
  const FIRSTRUN_DAYS = Math.min(365, Math.max(1, parseInt(process.env.REPLEN_FIRSTRUN_DAYS ?? "180", 10) || 180));
  // 30 days, not 7: Replen's positioning is "1-3 matches per MONTH", so a
  // 7-day steady window systematically missed ~3 weeks of every month's
  // candidates — a genuinely-relevant 55%-match for a project could sit just
  // outside the window and never surface. The cool-off (surfaced_count) stops
  // the same candidate repeating daily, so a wider window doesn't mean noise.
  const STEADY_DAYS = Math.min(120, Math.max(1, parseInt(process.env.REPLEN_STEADY_DAYS ?? "30", 10) || 30));
  const explicitDays = url.searchParams.get("days");
  const hasExplicitDays = explicitDays !== null && explicitDays.trim() !== "";
  // `days` for the explicit case is known now; the adaptive case is computed
  // AFTER project scope resolves, because first-run is per-PROJECT not
  // per-user (see the block after scope resolution). Placeholder until then.
  let days = hasExplicitDays
    ? Math.min(365, Math.max(1, parseInt(explicitDays!, 10) || STEADY_DAYS))
    : STEADY_DAYS;
  let windowReason = hasExplicitDays ? "explicit" : "steady";

  const filterMode = (auth.settings.filterMode ?? "tags") as "zero-knowledge" | "tags" | "fingerprint";

  // Resolve the project scope. When ?repo=owner/name is set we scope
  // to the matching projectProfile (and its tags, for filter mode
  // 'tags'). When unset, we operate user-wide and intersect tags
  // across all the user's projects.
  let scopedProjectId: number | null = null;
  let scopedProject: typeof schema.projectProfiles.$inferSelect | null = null;
  if (repoFilter) {
    // 1. Exact owner/name match.
    let p = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, auth.userId),
        sql`LOWER(${schema.projectProfiles.githubFullName}) = ${repoFilter}`,
      ))
      .get();

    // 2. Owner-tolerant fallback. Repos move orgs (e.g. nsokin → nsokin) and
    //    the registered owner drifts from the local remote, so the MCP-detected
    //    owner/name stops matching. When the exact match misses, match by repo
    //    NAME alone — but only when it unambiguously identifies a project,
    //    preferring an active+included+embedded row. This avoids a wrong match
    //    when two genuinely-different repos share a name across owners.
    if (!p && repoFilter.includes("/")) {
      const namePart = repoFilter.slice(repoFilter.indexOf("/") + 1);
      const byName = await db
        .select()
        .from(schema.projectProfiles)
        .where(and(
          eq(schema.projectProfiles.userId, auth.userId),
          sql`LOWER(substr(${schema.projectProfiles.githubFullName}, instr(${schema.projectProfiles.githubFullName}, '/') + 1)) = ${namePart}`,
        ));
      if (byName.length > 0) {
        byName.sort((a, b) =>
          (Number(!!(b.active && b.included)) - Number(!!(a.active && a.included))) ||
          (Number(b.embedding != null) - Number(a.embedding != null)) ||
          ((b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)),
        );
        p = byName[0];
      }
    }

    if (p && p.active && p.included) {
      scopedProjectId = p.id;
      scopedProject = p;
    } else {
      // Stay silent on the inventory in two cases:
      //   - the cwd's repo isn't a known project (surfacing matches for
      //     unrelated projects when the agent opens in /tmp or someone's
      //     dotfiles is noise), or
      //   - it IS a known project but the user excluded/deactivated it on
      //     /projects. An excluded project has no fresh embedding/search
      //     vectors, so any matches would be stale tag-only noise. Honour the
      //     user's "don't watch this repo" choice instead of leaking matches.
      // The caller can pass repo='' explicitly to override and see the
      // global firehose.
      return NextResponse.json(
        {
          filterMode,
          scopedTo: repoFilter,
          days,
          totalConsidered: 0,
          afterEligibility: 0,
          afterFilter: 0,
          candidates: [],
          displayText: null,
          note: p
            ? "project is excluded from matching on /projects; pass repo='' for the global firehose"
            : "repo not in your project list — this project isn't set up with Replen. Do NOT triage the global firehose (it's noise for this codebase). Instead, offer to onboard it: (1) git init + create the GitHub repo via `gh` if there's no remote, (2) write a README + a Replen-optimised CLAUDE.md so the scorer can read the project, (3) register it + add domain tags at app.replen.dev/projects, then re-run. Lead with a one-line offer.",
        },
        { headers: corsHeaders },
      );
    }
  }

  // Adaptive per-PROJECT lookback. First-run is keyed to the SCOPED PROJECT,
  // not the user: a project that has never surfaced a match the user engaged
  // with — one added today (crypto-fund), never run (cute), or dormant for
  // weeks (acme-web) — must get the wide first-run window even when the user
  // is well-established on OTHER repos. Keying first-run to the user instead
  // meant every newly-added project inherited the narrow steady window and its
  // months of backlog never surfaced. Unscoped (global firehose) falls back to
  // user-level. An explicit ?days= already won above and skips this.
  if (!hasExplicitDays) {
    const priorRows = scopedProjectId
      ? await db
          .select({ id: schema.userMatchState.id })
          .from(schema.userMatchState)
          .where(and(
            eq(schema.userMatchState.userId, auth.userId),
            eq(schema.userMatchState.projectId, scopedProjectId),
          ))
          .limit(1)
      : await db
          .select({ id: schema.userMatchState.id })
          .from(schema.userMatchState)
          .where(eq(schema.userMatchState.userId, auth.userId))
          .limit(1);
    const firstRun = priorRows.length === 0;
    days = firstRun ? FIRSTRUN_DAYS : STEADY_DAYS;
    windowReason = firstRun ? (scopedProjectId ? "first-run-project" : "first-run") : "steady";
  }

  // Build the user's tag set (for filter 'tags'). When scoped to one
  // project, use that project's tags only; otherwise union across all
  // included projects.
  let userTagSet = new Set<string>();
  if (filterMode === "tags" || filterMode === "fingerprint") {
    const tagSourceRows = scopedProjectId
      ? [scopedProject!]
      : await db
          .select()
          .from(schema.projectProfiles)
          .where(and(
            eq(schema.projectProfiles.userId, auth.userId),
            eq(schema.projectProfiles.active, true),
            eq(schema.projectProfiles.included, true),
          ));
    for (const p of tagSourceRows) {
      if (!p.tags) continue;
      try {
        const arr = JSON.parse(p.tags);
        if (Array.isArray(arr)) {
          for (const t of arr) {
            if (typeof t === "string") userTagSet.add(t.toLowerCase());
          }
        }
      } catch {
        // malformed tags JSON — skip, don't fail the whole request
      }
    }
  }

  // Pull recent candidates.
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const cands = await db
    .select()
    .from(schema.candidates)
    .where(and(
      eq(schema.candidates.userId, auth.userId),
      gte(schema.candidates.fetchedAt, since),
    ))
    .orderBy(desc(schema.candidates.score), desc(schema.candidates.fetchedAt))
    .limit(500); // cap to a sane upper bound before per-row filtering

  const totalConsidered = cands.length;

  // Excluded set. A repo is suppressed for one of two reasons:
  //   1. Terminal action — starred / hidden / handed_off: never re-surface.
  //   2. Cool-off — a 'surfaced' repo the user hasn't acted on, shown either
  //      too recently (within the cool-off window) or too many times total.
  //      Without this the inventory re-serves the same candidates every
  //      session until they're starred/hidden, so repeat users see the same
  //      footnote daily. The skill records 'surfaced' (with an incrementing
  //      count) via /api/state for every candidate it presents.
  const COOLOFF_HOURS = Math.max(0, parseInt(process.env.REPLEN_RESURFACE_COOLOFF_HOURS ?? "48", 10) || 48);
  const MAX_SURFACES = Math.max(1, parseInt(process.env.REPLEN_RESURFACE_MAX ?? "3", 10) || 3);
  const cooloffSince = new Date(Date.now() - COOLOFF_HOURS * 3600 * 1000);

  const stateRows = await db
    .select({
      repoId: schema.userMatchState.repoId,
      status: schema.userMatchState.status,
      surfacedAt: schema.userMatchState.surfacedAt,
      surfacedCount: schema.userMatchState.surfacedCount,
    })
    .from(schema.userMatchState)
    .where(eq(schema.userMatchState.userId, auth.userId));
  const excludedRepoIds = new Set<number>();
  for (const r of stateRows) {
    if (r.status === "starred" || r.status === "hidden" || r.status === "handed_off") {
      excludedRepoIds.add(r.repoId);
    } else if (r.status === "surfaced") {
      const tooMany = r.surfacedCount >= MAX_SURFACES;
      const tooRecent = r.surfacedAt != null && r.surfacedAt > cooloffSince;
      if (tooMany || tooRecent) excludedRepoIds.add(r.repoId);
    }
  }

  // Per-user triage suppression. When the in-session agent (Claude / Codex /
  // Gemini) triaged a repo and its verdict was 'skip' ("worse than what they
  // have, or wrong fit"), honour that like a soft hide — don't re-surface it
  // to this user. We use the LATEST verdict per repo so a later re-evaluation
  // to 'adopt' / 'port' / 'defer' un-sticks it. This is the AGENT's judgement
  // (triage_events), distinct from the USER's action (user_match_state) — but
  // for surfacing purposes a confident "skip" is signal enough to stop
  // pestering this user with the same repo.
  const triageRows = await db
    .select({
      repoId: schema.triageEvents.repoId,
      verdict: schema.triageEvents.verdict,
      createdAt: schema.triageEvents.createdAt,
    })
    .from(schema.triageEvents)
    .where(eq(schema.triageEvents.userId, auth.userId));
  const latestVerdictByRepo = new Map<number, { verdict: string; at: number }>();
  for (const t of triageRows) {
    const at = t.createdAt ? t.createdAt.getTime() : 0;
    const prev = latestVerdictByRepo.get(t.repoId);
    if (!prev || at >= prev.at) latestVerdictByRepo.set(t.repoId, { verdict: t.verdict, at });
  }
  for (const [repoId, v] of latestVerdictByRepo) {
    if (v.verdict === "skip") excludedRepoIds.add(repoId);
  }

  // Global demote (cross-user learning loop). A repo that enough DISTINCT
  // users have judged rubbish — latest-verdict skip ratio over threshold — is
  // suppressed for everyone, not just the users who skipped it. This is how
  // one user's "this is rubbish" protects the next user from the same noise.
  // Bounded read: only repos with at least the minimum number of triagers can
  // possibly qualify.
  const { minUsers: demoteMinUsers } = globalDemoteThresholds();
  const demoteRows = await db
    .select({
      repoId: schema.repoQuality.repoId,
      skipUsers: schema.repoQuality.skipUsers,
      totalUsers: schema.repoQuality.totalUsers,
    })
    .from(schema.repoQuality)
    .where(gte(schema.repoQuality.totalUsers, demoteMinUsers));
  for (const q of demoteRows) {
    if (isGloballyDemoted(q)) excludedRepoIds.add(q.repoId);
  }

  // Apply eligibility filter (cheap, deterministic). Reuses the same
  // structural rules the hosted pipeline runs at Stage 2.
  const eligibilityCtx = {
    detectedLanguages: auth.settings.detectedLanguages ?? null,
    knownDeps: null, // Skip Layer A for inventory — too expensive to recompute every request
  };
  type CandidateRow = typeof schema.candidates.$inferSelect;
  const eligible: CandidateRow[] = [];
  for (const c of cands) {
    const owner = c.githubUrl ? extractOwnerName(c.githubUrl)?.owner ?? null : null;
    const name = c.githubUrl ? extractOwnerName(c.githubUrl)?.name ?? null : null;
    const v = checkEligibility(
      {
        primaryLanguage: c.primaryLanguage,
        repoShape: (c.repoShape as RepoShape | null) ?? null,
        postedAt: c.postedAt,
        score: c.score,
        source: c.source,
        owner,
        name,
      },
      eligibilityCtx,
    );
    if (v.eligible) eligible.push(c);
  }
  const afterEligibility = eligible.length;

  // Filter-mode application + ranking.
  //
  // Two-stage ranking, in order of preference:
  //   1. Semantic similarity (cosine of OpenAI text-embedding-3-small)
  //      between the project's embedding and the candidate's embedding.
  //      This is the PRIMARY signal — it captures "is this candidate
  //      actually about what this project is about?" in a way bag-of-
  //      tags can't.
  //   2. Tag-overlap fallback: topicHits * 10 + (langHit ? 1 : 0).
  //      Used when either side lacks an embedding (lazy backfill hasn't
  //      reached them yet, or OPENAI_API_KEY isn't set on this instance).
  //
  // Pre-filter: when filter-mode is 'tags' / 'fingerprint' and the
  // project has any tags configured, drop candidates with zero topic
  // AND zero language overlap. Even semantic similarity benefits from
  // a coarse filter — a 50%-similar Rust GUI library isn't useful for
  // a Next.js webapp regardless of what cosine says.
  //
  // The project's embedding is loaded once if we're scoped to a single
  // project; for the union-of-projects path we skip semantic ranking
  // and fall back to tags only (semantically averaging vectors across
  // unrelated projects produces an incoherent query vector).
  const projectEmbedding = scopedProject
    ? parseStoredEmbedding(scopedProject.embedding ?? null)
    : null;

  // Faceted matching (Phase 1). Per-capability vectors for the scoped project.
  // A candidate is scored on its BEST facet, not the centroid — so a library
  // that fills ONE capability (a CV lib → "computer vision") surfaces even
  // though it's nowhere near the project's blended centroid. The centroid is
  // retained: a candidate that matches the WHOLE project (high centroid) rather
  // than a part is a competitor, and we use that to suppress same-domain apps.
  const projectFacets: FacetEmbedding[] = scopedProject
    ? parseStoredFacetEmbeddings(scopedProject.facetEmbeddings ?? null)
    : [];
  // An app whose centroid similarity clears this bar is "basically my whole
  // project" — a competitor, not a component. Suppressed unless it leads with a
  // specific capability (facet beats centroid by FACET_LEAD) or is a dep match.
  const COMPETITOR_CENTROID = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_COMPETITOR_CENTROID ?? "0.5")));
  const FACET_LEAD = Math.max(0, parseFloat(process.env.REPLEN_FACET_LEAD ?? "0.04"));

  // Relevance floor — "silence beats a weak match". A candidate must clear a
  // quality bar to be surfaced at all; if NONE do, the response is empty and
  // the footnote stays silent — better than interrupting with a 20%-cosine
  // macOS menu-bar app for a news site. The bar: when a cosine exists,
  // require it >= REPLEN_MIN_COSINE; otherwise a real tag/language hit
  // (relevance > 0) is the signal. Applied only on the scoped-project path
  // (where the footnote fires); zero-knowledge mode and the explicit global
  // firehose (repo='') opt out — there the user has asked to see everything.
  const MIN_COSINE = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_MIN_COSINE ?? "0.48")));
  const applyFloor = !!scopedProject && filterMode !== "zero-knowledge";

  // Pattern A — "watch your stack". A release from a vendor the SCOPED project
  // actually depends on is the strongest possible signal ("a thing you depend
  // on just shipped"): it bypasses the relevance floor and sorts above semantic
  // matches. We intersect each stack-watch candidate's tagged package names
  // (carried in its topics) with this project's parsed dependencies.
  const scopedProjectDeps = parseTechSummaryDeps(scopedProject?.techSummary ?? null);

  type ScoredRow = CandidateRow & {
    whyShortlisted: string;
    relevance: number;        // tag-overlap fallback score
    cosine: number | null;    // BEST of centroid / facet similarity (null when unavailable)
    matchedFacet: string | null; // which capability this hit, when facet-led (else null)
    depMatch: boolean;        // Pattern A: release of a vendor this project depends on
  };
  const filtered: ScoredRow[] = [];
  for (const c of eligible) {
    const reasons: string[] = [];
    let relevance = 0;
    let topicHits: string[] = [];
    let langHit = false;

    if (filterMode === "zero-knowledge") {
      reasons.push("zero-knowledge mode: no per-user filter applied");
    } else if (filterMode === "tags" || filterMode === "fingerprint") {
      // v1: fingerprint mode falls back to tags. Real LSH similarity
      // ranking is a follow-up.
      try {
        const candTopics: string[] = c.topics ? JSON.parse(c.topics) : [];
        topicHits = candTopics.map((t) => t.toLowerCase()).filter((t) => userTagSet.has(t));
      } catch {
        // ignore malformed topics JSON
      }
      langHit = !!(c.primaryLanguage && userTagSet.has(c.primaryLanguage.toLowerCase()));
      if (userTagSet.size === 0) {
        // No tags configured yet — degrade gracefully to passthrough rather than
        // returning an empty inventory and looking broken.
        reasons.push("no project tags configured; showing unfiltered");
      } else if (topicHits.length === 0 && !langHit) {
        continue; // coarse pre-filter: drop hard misses even when embeddings agree
      } else {
        if (langHit) reasons.push(`language match: ${c.primaryLanguage}`);
        if (topicHits.length > 0) reasons.push(`topic overlap: ${topicHits.slice(0, 3).join(", ")}`);
        relevance = topicHits.length * 10 + (langHit ? 1 : 0);
      }
    }

    // Semantic similarity layered on top. Only meaningful when both
    // sides have an embedding; otherwise null → falls back to relevance.
    //
    // Faceted (Phase 1): score the candidate against the project CENTROID and
    // against each capability FACET, then take the best. centroidCos measures
    // "is this my whole project?" (high = competitor); the best facet measures
    // "does this fill a capability I have?" (high = useful component). The
    // surfaced `cosine` is the max — so a library that nails one capability
    // ranks on that strength even when its centroid match is near zero.
    let cosine: number | null = null;
    let centroidCos: number | null = null;
    let matchedFacet: string | null = null;
    let facetLeadsCentroid = false; // a capability beats the whole-project match by a margin
    if (projectEmbedding) {
      const candEmbedding = parseStoredEmbedding(c.embedding ?? null);
      if (candEmbedding) {
        const cSim = cosineSimilarity(projectEmbedding, candEmbedding);
        if (Number.isFinite(cSim)) centroidCos = cSim;

        let bestFacetCos = -Infinity;
        let bestFacetLabel: string | null = null;
        for (const f of projectFacets) {
          const fSim = cosineSimilarity(f.vec, candEmbedding);
          if (Number.isFinite(fSim) && fSim > bestFacetCos) {
            bestFacetCos = fSim;
            bestFacetLabel = f.label;
          }
        }

        const cVal = centroidCos ?? -Infinity;
        const best = Math.max(cVal, bestFacetCos);
        facetLeadsCentroid = Number.isFinite(bestFacetCos) && bestFacetCos >= cVal + FACET_LEAD;
        if (Number.isFinite(best)) {
          cosine = best;
          // Facet-led when a specific capability beats the centroid: that's the
          // "fills a part of my project" signal we want to surface and label.
          if (bestFacetLabel !== null && bestFacetCos >= cVal) {
            matchedFacet = bestFacetLabel;
            reasons.push(`fits your ${bestFacetLabel} capability: ${(bestFacetCos * 100).toFixed(0)}%`);
          } else {
            reasons.push(`semantic similarity: ${(best * 100).toFixed(0)}%`);
          }
        }
      }
    }

    // Stake match (Patterns A/B/C). A feed candidate whose tagged package
    // signals are in the scoped project's deps is a TRUE stake — a dependency
    // you use shipped (A), a standard you implement changed (B), or an upstream
    // you build on looks risky (C). Surface it no matter what cosine says.
    let depMatch = false;
    const stakeKind =
      c.source.startsWith("stack-watch:") ? "stack" :
      c.source.startsWith("spec-watch:") ? "spec" :
      c.source.startsWith("health-watch:") ? "health" : null;
    if (scopedProject && scopedProjectDeps.size > 0 && stakeKind) {
      let candTopics: string[] = [];
      try { candTopics = c.topics ? JSON.parse(c.topics) : []; } catch { /* ignore */ }
      depMatch = candTopics.some((t) => typeof t === "string" && scopedProjectDeps.has(t.toLowerCase()));
      if (depMatch) {
        reasons.unshift(
          stakeKind === "spec" ? `a standard your code implements changed — ${c.title}` :
          stakeKind === "health" ? `an upstream you depend on needs attention — ${c.title}` :
          `you depend on this — new ${c.title}`,
        );
      }
    }

    // Relevance floor: drop candidates that don't clear the bar so weak
    // matches never reach the user (and an all-weak result stays silent). A
    // dependency match is exempt — it's the strongest signal we have.
    if (applyFloor && !depMatch) {
      const clears = cosine !== null ? cosine >= MIN_COSINE : relevance > 0;
      if (!clears) continue;
    }

    // Competitor suppression (Phase 1). An APP that matches the project's whole
    // centroid (not a specific capability) is a competitor — it does what you
    // do, you can't adopt it. Drop it. Libraries/tools are never suppressed
    // (you can always use or learn from them), and an app that LEADS with a
    // specific capability (facet beats centroid by FACET_LEAD) is kept — it
    // fills a part rather than duplicating the whole. Gated on the project
    // having facets, so un-faceted (pre-backfill) projects are unaffected. Dep
    // matches are always exempt.
    if (
      applyFloor &&
      !depMatch &&
      projectFacets.length > 0 &&
      (c.repoShape as string | null) === "app" &&
      centroidCos !== null &&
      centroidCos >= COMPETITOR_CENTROID &&
      !facetLeadsCentroid
    ) {
      continue;
    }

    filtered.push({
      ...c,
      whyShortlisted: reasons.join("; ") || "candidate eligible",
      relevance,
      cosine,
      matchedFacet,
      depMatch,
    });
  }

  // Sort: cosine similarity is the primary signal when available.
  // Candidates with cosine scores rank by cosine desc. Candidates
  // without cosine (lazy-backfill not yet reached them) interleave by
  // their tag-overlap relevance — they aren't penalised vs. embedded
  // ones until the embedding lands.
  filtered.sort((a, b) => {
    // Both have cosine: pure cosine ordering.
    if (a.cosine !== null && b.cosine !== null) return b.cosine - a.cosine;
    // One has cosine, other doesn't: prefer the one WITH cosine —
    // a known semantic fit beats an unknown.
    if (a.cosine !== null) return -1;
    if (b.cosine !== null) return 1;
    // Neither has cosine: fall back to tag-overlap relevance.
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return 0;
  });
  const afterFilter = filtered.length;

  // Feed candidates (Pattern A stack-watch / Pattern B spec-watch) carry their
  // own display data and must NOT be dropped for lacking a `repos` row — their
  // repo may have never been a candidate before (a vendor release / spec
  // change), and chrome-status items have no GitHub repo at all. In skill tier
  // the hosted analysis pipeline (which upserts `repos`) never runs, so we
  // can't assume a row exists. Normal candidates still go through the repos
  // join for canonical metadata (stars/license/etc.); feed candidates are
  // hydrated directly from the candidate row below.
  const isFeedSource = (src: string) =>
    src.startsWith("stack-watch:") || src.startsWith("spec-watch:") || src.startsWith("health-watch:");
  const normalFiltered = filtered.filter((c) => !isFeedSource(c.source));
  const feedFiltered = filtered.filter((c) => isFeedSource(c.source));

  // Apply excluded-repo filter via the candidates' resolved owner/name → repo lookup.
  // For now: do a per-candidate lookup against the repos table for the rich fields.
  const ownerNamePairs = normalFiltered
    .map((c) => {
      const on = c.githubUrl ? extractOwnerName(c.githubUrl) : null;
      return on ? { ...c, owner: on.owner, name: on.name } : null;
    })
    .filter((x): x is (typeof filtered[number] & { owner: string; name: string }) => x !== null);

  // Fetch repos in bulk.
  const repoLookups = await Promise.all(
    ownerNamePairs.map(async (c) => {
      const r = await db
        .select()
        .from(schema.repos)
        .where(and(eq(schema.repos.owner, c.owner), eq(schema.repos.name, c.name)))
        .get();
      return { c, r };
    }),
  );

  // Dedup by repoId: multiple sources can surface the same repo (e.g.
  // ossinsight-trending:all + gh-search-recent:all + reddit:LocalLLaMA
  // each independently picking up NousResearch/hermes-agent). Keep the
  // first occurrence (already sorted by candidate score desc → stars desc,
  // so we keep the strongest-source attribution).
  const seenRepoIds = new Set<number>();
  const dedup = repoLookups.filter(({ r }) => {
    if (!r) return false;
    if (excludedRepoIds.has(r.id)) return false;
    if (seenRepoIds.has(r.id)) return false;
    seenRepoIds.add(r.id);
    return true;
  });

  // Unified output shape for own-pool candidates AND cross-user promotions, so
  // the two streams merge and sort together.
  type OutEntry = {
    candidateId: number | null;
    repoId: number | null;
    repo: string;
    title: string;
    url: string | null;
    description: string | null;
    stars: number | null;
    language: string | null;
    license: string | null;
    topics: string[];
    repoShape: string | null;
    source: string;
    postedAt: string | null;
    pushedAt: string | null;
    whyShortlisted: string;
    cosine: number | null;
    matchedFacet: string | null; // capability this candidate fills, when facet-led
    promoted: boolean;
    dependencyMatch: boolean;
    projectMatch: string | null;
  };

  // Normalised own-pool entries (this user's candidates), full list pre-merge.
  const ownOut: OutEntry[] = dedup.map(({ c, r }) => ({
    candidateId: c.id as number | null,
    repoId: r!.id,
    repo: `${r!.owner}/${r!.name}`,
    title: `${r!.owner}/${r!.name}`,
    url: r!.url,
    description: r!.description,
    stars: r!.stars,
    language: r!.primaryLanguage,
    license: r!.license,
    topics: c.topics ? safeParseJsonArray(c.topics) : [],
    repoShape: c.repoShape as string | null,
    source: c.source,
    postedAt: c.postedAt?.toISOString() ?? null,
    pushedAt: r!.pushedAt?.toISOString() ?? null,
    whyShortlisted: c.whyShortlisted,
    cosine: c.cosine as number | null,
    matchedFacet: c.matchedFacet,
    promoted: false,
    dependencyMatch: c.depMatch,
    projectMatch: scopedProject?.slug ?? null,
  }));

  // Feed candidates (Pattern A / B), hydrated directly from the candidate row.
  // We still best-effort resolve a repoId when the item has a GitHub repo (for
  // state-keying + exclusion), but never DROP on a missing one.
  const feedOut: OutEntry[] = [];
  const feedSeen = new Set<string>();
  for (const c of feedFiltered) {
    const on = c.githubUrl ? extractOwnerName(c.githubUrl) : null;
    let repoId: number | null = null;
    if (on) {
      const r = await db
        .select({ id: schema.repos.id })
        .from(schema.repos)
        .where(and(eq(schema.repos.owner, on.owner), eq(schema.repos.name, on.name)))
        .get();
      repoId = r?.id ?? null;
    }
    if (repoId !== null && excludedRepoIds.has(repoId)) continue;
    const dedupKey = repoId !== null ? `r:${repoId}` : `${c.source}:${c.sourceItemId}`;
    if (feedSeen.has(dedupKey)) continue;
    feedSeen.add(dedupKey);
    const raw = safeParseRaw(c.rawJson);
    feedOut.push({
      candidateId: c.id,
      repoId,
      repo: on ? `${on.owner}/${on.name}` : (asString(raw?.specName) ?? asString(raw?.vendor) ?? c.source),
      title: asString(c.title) ?? (on ? `${on.owner}/${on.name}` : c.source),
      url: c.url,
      description: asString(raw?.notes) ?? asString(raw?.summary) ?? null,
      stars: null,
      language: null,
      license: null,
      topics: c.topics ? safeParseJsonArray(c.topics) : [],
      repoShape: null,
      source: c.source,
      postedAt: c.postedAt?.toISOString() ?? null,
      pushedAt: null,
      whyShortlisted: c.whyShortlisted,
      cosine: c.cosine as number | null,
      matchedFacet: null,
      promoted: false,
      dependencyMatch: c.depMatch,
      projectMatch: scopedProject?.slug ?? null,
    });
  }

  // Similar-project promotions (L4b cross-user learning loop): repos that
  // earned a positive verdict from users whose project is embedding-similar to
  // this one, even though they're not in this user's own pool. Only on the
  // scoped-project path with an embedding (the signal is project-to-project
  // similarity). Excludes anything already surfaced or excluded for this user.
  let promotedOut: OutEntry[] = [];
  if (scopedProject && projectEmbedding) {
    const alreadyHave = new Set<number>(excludedRepoIds);
    for (const o of [...ownOut, ...feedOut]) if (o.repoId !== null) alreadyHave.add(o.repoId);
    const promos = await findSimilarProjectPromotions({
      userId: auth.userId,
      projectEmbedding,
      excludeRepoIds: alreadyHave,
    });
    promotedOut = promos.map((p) => ({
      candidateId: p.candidateId,
      repoId: p.repoId,
      repo: p.repo,
      title: p.repo,
      url: p.url,
      description: p.description,
      stars: p.stars,
      language: p.language,
      license: p.license,
      topics: p.topics,
      repoShape: p.repoShape,
      source: p.source,
      postedAt: p.postedAt,
      pushedAt: p.pushedAt,
      whyShortlisted: p.whyShortlisted,
      cosine: p.cosine as number | null,
      matchedFacet: null,
      promoted: true,
      dependencyMatch: false,
      projectMatch: scopedProject?.slug ?? null,
    }));
  }

  // Merge own + feed (Pattern A/B) + promoted, rank: dependency / standard
  // stake matches first ("a thing you depend on / a standard you implement just
  // changed"), then by cosine desc (entries without a cosine sink to the bottom
  // but keep their relevance order via stable sort). Dedup by repoId; repo-less
  // feed items (chrome-status) are inherently unique and always pass. Cap to limit.
  const mergedSeen = new Set<number>();
  const candidatesOut = [...ownOut, ...feedOut, ...promotedOut]
    .sort((a, b) => {
      if (a.dependencyMatch !== b.dependencyMatch) return a.dependencyMatch ? -1 : 1;
      return (b.cosine ?? -1) - (a.cosine ?? -1);
    })
    .filter((e) => {
      if (e.repoId === null) return true;
      if (mergedSeen.has(e.repoId)) return false;
      mergedSeen.add(e.repoId);
      return true;
    })
    .slice(0, limit);

  // Pre-formatted user-facing footnote string. Built server-side so the
  // agent doesn't have to derive it from the JSON (which has historically
  // been the unreliable bit — agents inconsistently formatted or skipped
  // it). The MCP server surfaces this directly under a USER-FACING
  // MESSAGE block in its tool response, with the tool description
  // instructing the agent to relay it verbatim.
  let displayText: string | null = null;
  if (candidatesOut.length > 0 && scopedProject) {
    const top = candidatesOut[0];
    if (top.dependencyMatch) {
      // Pattern A/B lead: a vendor the project depends on shipped, or a
      // standard the project implements changed.
      const lead = top.source.startsWith("spec-watch:")
        ? `a standard your code implements just changed — ${top.title}`
        : top.source.startsWith("health-watch:")
        ? `an upstream you depend on needs attention — ${top.title}`
        : `a dependency you use just shipped — ${top.title}`;
      displayText = `By the way — ${lead}. ${candidatesOut.length} Replen candidate${candidatesOut.length === 1 ? "" : "s"} queued for this repo — want me to triage them?`;
    } else if (top.matchedFacet) {
      // Facet-led: surface WHICH capability it fills, not a bare "% match".
      // This is the component-fit framing — "helps with your X" rather than
      // "looks like your project" (which would be a competitor).
      const topDesc = top.description ? ` — ${top.description.slice(0, 70).replace(/\.$/, "")}` : "";
      displayText = `By the way — \`${top.repo}\` could help with your ${top.matchedFacet}${topDesc}. ${candidatesOut.length} Replen candidate${candidatesOut.length === 1 ? "" : "s"} queued for this repo — want me to triage them?`;
    } else {
      const simStr = typeof top.cosine === "number" ? ` (~${Math.round(top.cosine * 100)}% match)` : "";
      const topDesc = top.description ? ` — ${top.description.slice(0, 80).replace(/\.$/, "")}` : "";
      displayText = `By the way — ${candidatesOut.length} Replen candidate${candidatesOut.length === 1 ? "" : "s"} queued for this repo. Top: \`${top.repo}\`${simStr}${topDesc}. Want me to triage them?`;
    }
  }

  return NextResponse.json(
    {
      filterMode,
      scopedTo: scopedProject ? `${scopedProject.slug} (${scopedProject.githubFullName})` : null,
      days,
      windowReason,
      minCosine: applyFloor ? MIN_COSINE : null,
      totalConsidered,
      afterEligibility,
      afterFilter,
      returned: candidatesOut.length,
      displayText,
      candidates: candidatesOut,
    },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function extractOwnerName(url: string): { owner: string; name: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

// Parse a candidate's raw_json blob (feed candidates stash their display data
// there). Returns a plain record or null; callers pull fields defensively.
function safeParseRaw(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
