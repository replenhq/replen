import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { checkEligibility } from "@/analyzer/eligibility";
import type { RepoShape } from "@/fetchers/repo-shape";
import { cosineSimilarity, parseStoredEmbedding, parseStoredFacetEmbeddings, type FacetEmbedding } from "@/lib/embeddings";
import { catalogueMatches, adjacentMatches } from "@/catalogue/reader";
import { deriveProductKey } from "@/projects/product-key";
import { isGenericProbeFacetLabel, isNoiseFacetLabel } from "@/projects/doc-sections";
import { globalDemoteThresholds, isGloballyDemoted } from "@/lib/repo-quality";
import { findSimilarProjectPromotions } from "@/lib/cross-user-promote";
import { parseDepVersionNames, parseTechSummaryDeps, vendorForDep } from "@/fetchers/stack-watch/registry";
import { clientUpgradeNudge, withUpgradeNudge } from "@/lib/client-version";
import { loadModalitySuppressions, loadTriageContext, loadDeferRechecks, normFacetLabel } from "@/lib/triage-memory";
import { suggestUpgrades, suggestPracticeTransfer, coveredCapabilities } from "@/lib/keystone";
import { computeLeaps, type Leap } from "@/graph/leaps";
import { pricingPs, pricingUserTokens } from "@/pricing/surface";
import { announcementPs } from "@/announcements/surface";
import { deadlinePs } from "@/announcements/deadlines";
import { alternativesFor, type Alternative } from "@/lib/alternatives";
import { loadTasteVector, tasteBoost } from "@/lib/taste";
import { loadOutcomePriors, priorBoost, sourcePrefix } from "@/lib/outcome-priors";
import { calibratedFloor } from "@/lib/calibration";
import { loadRankHints, type RankHints } from "@/graph/coverage";
import type { Modality, Provenance } from "@/projects/modality";

// Skill-mode inventory endpoint.
//
// What this is NOT: the legacy /api/mcp/today, which returned LLM-
// scored matches with writeups produced by the hosted pipeline. This
// returns raw candidates from the inventory, lightly filtered, with
// NO LLM output — the calling skill produces writeups in-session
// using the user's subscription tokens.
//
// What this IS: a per-user, filter-mode-aware view of the last N days
// of fetched candidates. Two filter modes:
//   - 'zero-knowledge': passthrough (full firehose). Most private.
//     User opts in to send Replen literally nothing about their
//     projects beyond a DIGEST_TOKEN for identity.
//   - 'tags' (default): intersect candidate
//     primaryLanguage/topics with the user's project_profiles.tags
//     JSON array. Tags are user-curated metadata, not source code.
// (A third 'fingerprint' mode was specced — an LSH-style shape-hash
// pre-filter — but never implemented; any stored 'fingerprint' value is
// normalised to 'tags' below. The project_profiles.fingerprint_hash column
// is reserved/unused.)
//
// Exclusion of user-state: candidates whose repo already has a
// user_match_state row of 'starred', 'hidden', or 'handed_off' for
// this user are silently excluded. The skill never re-surfaces what
// the user has already engaged with (or actively dismissed).
//
// Returns: an ordered list of candidates with repo metadata + a
// cheap server-derived `whyShortlisted` line. The skill ranks and
// writes up these candidates in-session — that's the whole point.
// Truncate a description for inline use in the footnote at a WORD boundary, so
// it never ends mid-word. The old `.slice(0, n)` produced "…image semantic
// segmentation wi." — chopped mid-word with the template's period stuck on.
// Trailing punctuation is stripped; the caller's template supplies the period.
function clipDesc(desc: string, max: number): string {
  const d = desc.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  if (d.length <= max) return d;
  const cut = d.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, "");
}

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }

  // Tell stale clients to refresh (npx caches old builds; the old build can't
  // self-detect, so the server does). Appended to the footnote below.
  const upgradeNudge = await clientUpgradeNudge(req.headers.get("x-replen-client"));

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

  // Only two real modes; a legacy/stored 'fingerprint' value (never implemented)
  // normalises to 'tags'.
  const filterMode: "zero-knowledge" | "tags" = auth.settings.filterMode === "zero-knowledge" ? "zero-knowledge" : "tags";

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

    // 2. Owner-tolerant fallback. Repos move orgs (renames, transfers) and
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

      // Part 2 — onboard-on-first-visit. The repo is registered (identity +
      // tags — e.g. auto-registered by the SessionStart hook, Part 1) but has
      // no capability facets yet, so faceted matching would be noise. Instead
      // of running it, surface a calm offer to profile the repo IN-SESSION:
      // the agent is already sitting in the code, so it can read the source,
      // derive grounded capabilities, and call replen_set_capabilities right
      // now — no separate onboarding step for the user to remember. Once
      // facetEmbeddings exist, this branch stops firing and matching takes
      // over. facetEmbeddings is the canonical "is profiled" signal (mirrors
      // hasCapabilities in /api/projects/state).
      if (scopedProject.facetEmbeddings == null) {
        return NextResponse.json(
          {
            filterMode,
            scopedTo: repoFilter,
            days,
            totalConsidered: 0,
            afterEligibility: 0,
            afterFilter: 0,
            candidates: [],
            needsOnboarding: true,
            displayText: withUpgradeNudge(
              "This repo is set up in Replen but I haven't profiled its capabilities yet, so I can't surface good matches for it. Want me to read the code and build its capability profile now? (Runs here in-session — no API key, a couple of minutes.)",
              upgradeNudge,
            ),
            note:
              "This project is registered but UNPROFILED (identity + tags only, no capability facets) — do NOT triage the inventory (there is nothing meaningful to score yet). Instead, ONBOARD it in-session if the user accepts the offer above: " +
              "(1) read the actual source (src/, lib/, app/ — skip node_modules/dist/.next) to understand what it does; " +
              "(2) derive 8-15 SPECIFIC, grounded capabilities as {tag, descriptor, modality, paths} objects (descriptor = one sentence grounded in the real code: the data it operates on, the task, key constraints; modality from image/video/timeseries/tabular/text/audio/geospatial/graph/3d/code/network, or []); " +
              "(3) call replen_set_capabilities (mode='replace') with those capabilities, plus a short grounded `report` and a 1-2 sentence `purpose` when you can; " +
              "(4) read the lockfile and call replen_set_versions with the resolved direct dependency versions; " +
              "(5) call replen_set_tags with a DENSE, RANKED domain tag cloud (aim 25-50+, most-central first) — the WORLD the project operates in: sector + synonyms ('estate-agents','letting-agents','property','proptech'), job-to-be-done ('lead-generation','lead-routing'), and entities/data ('uk-postcodes','uk-addresses','landlords','property-listings'). DISAMBIGUATE BY DENSITY: for any ambiguous term emit its synonyms/abbreviations/neighbours too (not just 'uas' but 'unmanned-systems','uav','drone','drones','military-drones') so the collective pins the meaning. GROUNDED ONLY. EXCLUDE stack ('typescript'/'next.js'/'react'/'firebase' — those go via replen_set_versions) and generic SaaS plumbing ('auth','signup','subscription-management','crud'). The auto-detected stack tags from registration are near-useless for matching; the dense domain cloud is what lets matching surface relevant candidates instead of generic frameworks. " +
              "Matching then works on the next replen_match. Lead with the one-line offer; only do the work if the user accepts.",
          },
          { headers: corsHeaders },
        );
      }
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
          displayText: withUpgradeNudge(null, upgradeNudge),
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
  if (filterMode === "tags") {
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
  // Kept separately for the defer re-check path, which bypasses the surfacing
  // cool-off (a re-check is deliberate re-surfacing) but must still honour the
  // user's terminal actions and not nag (own, longer cool-off via surfacedAt).
  const terminalRepoIds = new Set<number>();
  const lastSurfacedByRepo = new Map<number, number>();
  for (const r of stateRows) {
    if (r.status === "starred" || r.status === "hidden" || r.status === "handed_off") {
      excludedRepoIds.add(r.repoId);
      terminalRepoIds.add(r.repoId);
    } else if (r.status === "surfaced") {
      const tooMany = r.surfacedCount >= MAX_SURFACES;
      const tooRecent = r.surfacedAt != null && r.surfacedAt > cooloffSince;
      if (tooMany || tooRecent) excludedRepoIds.add(r.repoId);
    }
    if (r.surfacedAt != null) lastSurfacedByRepo.set(r.repoId, r.surfacedAt.getTime());
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

  // Contextual triage memory (the learning loop, read side):
  //   modalitySuppress — (repo × modality) collisions agents recorded. Sharper
  //     than global demote: anomalib stays great for image projects and stops
  //     surfacing against timeseries facets.
  //   prior — this user's decision log, attached to candidates as priorContext
  //     ("you already cover X with Y") so in-session triage starts with memory.
  const modalitySuppress = await loadModalitySuppressions(auth.userId);
  const prior = await loadTriageContext(auth.userId);
  // The learning trio + graph hints (all degrade silently with no history):
  //   hints  — waypoint/blind-spot capability labels + related projects (graph)
  //   taste  — Rocchio vector over this project's (and relatives') verdicts
  //   priors — Laplace hit-rates per source / per facet from triage outcomes
  const hints: RankHints = scopedProject
    ? await loadRankHints(auth.userId, scopedProject.slug)
    : { waypointLabels: new Set<string>(), unfilledLabels: new Set<string>(), relatedSlugs: [] };
  const taste = scopedProject ? await loadTasteVector(auth.userId, scopedProjectId, hints.relatedSlugs) : null;
  const outcomePriors = await loadOutcomePriors(auth.userId);
  const WAYPOINT_BOOST = Math.max(0, parseFloat(process.env.REPLEN_WAYPOINT_BOOST ?? "0.02"));
  const BLINDSPOT_BOOST = Math.max(0, parseFloat(process.env.REPLEN_BLINDSPOT_BOOST ?? "0.02"));
  const GOAL_BOOST = Math.max(0, parseFloat(process.env.REPLEN_GOAL_BOOST ?? "0.04"));
  // Tools the user declared they're migrating off — that vendor's release
  // stream is noise on the way out, and matches reinforcing the dependency
  // shouldn't surface.
  const migrateOffTools = new Set(
    (await db.select({ tool: schema.toolPrefs.tool }).from(schema.toolPrefs)
      .where(and(eq(schema.toolPrefs.userId, auth.userId), eq(schema.toolPrefs.migrateOff, true))))
      .map((t) => t.tool),
  );
  // Curation rules: deleted labels must never act as match probes again,
  // even if a facet regeneration resurrects them in storage.
  const curatedDeletes = new Set(
    (await db.select({ normLabel: schema.capabilityCurations.normLabel, action: schema.capabilityCurations.action })
      .from(schema.capabilityCurations).where(eq(schema.capabilityCurations.userId, auth.userId)))
      .filter((c) => c.action === "delete").map((c) => c.normLabel),
  );

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
  // Multi-repo products: union the scoped repo's facets with its SIBLING repos'
  // facets (same product_key), so a capability that lives in a sibling you never
  // open (acme-cv) still surfaces while you work in the repo you do (acme-web).
  // Sibling facets are tagged with their repo slug for attribution.
  const projectFacets: FacetEmbedding[] = scopedProject
    ? parseStoredFacetEmbeddings(scopedProject.facetEmbeddings ?? null)
    : [];
  let productRepoCount = 1;
  // Dep tokens across the whole product — a library the project (or a sibling)
  // already depends on must never be suggested back. TWO sources, unioned:
  // the legacy tech_summary deps line (Node projects only) and the
  // agent-reported dep_versions map — the only dep source that exists for
  // Python/Rust/Go repos. Suggesting fastapi to the project that pins it was
  // a real shipped failure; this union is what prevents it.
  const productDeps = new Set<string>(parseTechSummaryDeps(scopedProject?.techSummary ?? null));
  for (const d of parseDepVersionNames(scopedProject?.depVersions ?? null)) productDeps.add(d);
  // Defensive facet hygiene: a repo's OWN name/slug is a title blob, not a
  // capability, and must never be a probe. We drop these (across the whole
  // product) at READ time too — not just at generation — so legacy facets
  // stored before the slug-drop + noise filters stop producing junk matches
  // immediately, without waiting on a full facet regen.
  const normName = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const dropFacetNorms = new Set<string>();
  const addDropName = (s?: string | null) => {
    if (!s) return;
    const n = normName(s);
    if (!n) return;
    dropFacetNorms.add(n);
    dropFacetNorms.add(n.replace(/\s+(web|app|api|ui|frontend|backend|server|client|cli|core|service|mobile|cv|edge|infra|engine)$/i, "").trim());
  };
  addDropName(scopedProject?.name);
  addDropName(scopedProject?.slug);
  // Slugs in the scoped product (the scoped repo + its siblings) — used to
  // scope defer re-checks to decisions made for THIS product, not the whole
  // portfolio.
  const productSlugs = new Set<string>();
  if (scopedProject) productSlugs.add(scopedProject.slug);
  if (scopedProject) {
    const productKey = scopedProject.productKey ?? deriveProductKey(scopedProject.githubFullName);
    if (productKey) {
      const siblings = await db
        .select({ slug: schema.projectProfiles.slug, githubFullName: schema.projectProfiles.githubFullName, facetEmbeddings: schema.projectProfiles.facetEmbeddings, productKey: schema.projectProfiles.productKey, techSummary: schema.projectProfiles.techSummary, depVersions: schema.projectProfiles.depVersions })
        .from(schema.projectProfiles)
        .where(and(
          eq(schema.projectProfiles.userId, auth.userId),
          eq(schema.projectProfiles.active, true),
          eq(schema.projectProfiles.included, true),
        ));
      for (const s of siblings) {
        if (s.slug === scopedProject.slug) continue;
        const sKey = s.productKey ?? deriveProductKey(s.githubFullName);
        if (sKey !== productKey) continue;
        productRepoCount++;
        productSlugs.add(s.slug);
        for (const f of parseStoredFacetEmbeddings(s.facetEmbeddings ?? null)) {
          projectFacets.push({ ...f, repo: s.slug });
        }
        for (const d of parseTechSummaryDeps(s.techSummary)) productDeps.add(d);
        for (const d of parseDepVersionNames(s.depVersions)) productDeps.add(d);
        addDropName(s.slug);
        addDropName(s.githubFullName?.split("/")[1] ?? null);
      }
    }
  }
  // Apply the defensive facet hygiene: drop the product's own name/slug probes
  // and any structural/teleprompter-style noise label (timestamps, numbered
  // slugs) that legacy generation let through.
  for (let i = projectFacets.length - 1; i >= 0; i--) {
    const label = projectFacets[i].label;
    if (isNoiseFacetLabel(label) || dropFacetNorms.has(normName(label)) || curatedDeletes.has(normName(label))) projectFacets.splice(i, 1);
  }
  // GOALS — aspirational facets. Embedded like capabilities but flagged: a
  // match that advances a goal gets a ranking boost and is exempt from the
  // covered-facet penalty (you can't already "cover" something you want).
  const goalLabels = new Set<string>();
  if (scopedProject) {
    const goalRows = await db.select().from(schema.capabilityGoals)
      .where(and(eq(schema.capabilityGoals.userId, auth.userId), eq(schema.capabilityGoals.status, "active")));
    for (const g of goalRows) {
      if (g.projectSlug != null && !productSlugs.has(g.projectSlug)) continue;
      const vec = parseStoredEmbedding(g.embedding ?? null);
      if (!vec) continue;
      projectFacets.push({ label: g.label, vec, modality: [], provenance: "grounded" });
      goalLabels.add(normFacetLabel(g.label));
    }
  }
  // PROBE facets — the subset allowed to LEAD a match, seed adjacency, or
  // pull catalogue suggestions. Generic infrastructure plumbing (S3, Docker,
  // CI/CD, deployment) is excluded: it's a capability almost every project
  // has, so as a probe it matches half of GitHub ("adjacent to your AWS S3"
  // shortlisting a serverless framework for a GPU-serving repo). The full
  // projectFacets list still drives coverage, modality maps, and the
  // "already have it" adjacency exclusion. A facet the user explicitly set
  // as a GOAL is exempt — stated intent beats the genericity heuristic.
  // Facets the agent skipped as 'covered' (built in-house) for any repo in
  // this product — dropped as probes so a low-trust facet can't keep pulling a
  // fresh tool from a crowded catalogue category every session. Stays exempt
  // when set as a goal (you may build it now AND want better tooling later).
  const coveredSkipFacets = new Set<string>();
  for (const slug of productSlugs) for (const f of prior.coveredSkips.get(slug) ?? []) coveredSkipFacets.add(f);
  const probeFacets = projectFacets.filter((f) => {
    const nf = normFacetLabel(f.label);
    if (goalLabels.has(nf)) return true; // stated intent overrides every suppression
    if (isGenericProbeFacetLabel(f.label)) return false; // infra + vague-generic
    if (coveredSkipFacets.has(nf)) return false;
    return true;
  });
  // Modality per facet label (union across product repos) — for checking a
  // candidate's recorded modality collisions against the facet it matched.
  const facetModsByLabel = new Map<string, Modality[]>();
  for (const f of projectFacets) {
    if (!f.modality?.length) continue;
    const k = normFacetLabel(f.label);
    facetModsByLabel.set(k, [...new Set([...(facetModsByLabel.get(k) ?? []), ...f.modality])]);
  }
  // Map deps to their canonical GitHub repos (next → vercel/next.js), so the
  // exclusion catches libraries whose package name ≠ repo name.
  const knownRepoFullNames = new Set<string>();
  // Capability facets the project ALREADY has a dependency for ("Tailwind CSS"
  // because it uses tailwindcss). Matches led by these are "more of what you
  // have" — down-ranked so genuine gaps + non-obvious finds surface instead.
  const coveredFacets = new Set<string>();
  const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const d of productDeps) {
    coveredFacets.add(normLabel(d));
    const v = vendorForDep(d);
    if (v) { knownRepoFullNames.add(v.githubRepo.toLowerCase()); coveredFacets.add(normLabel(v.name)); }
  }
  // Self-match guard: a user's own project repos must never be surfaced as
  // candidates to themselves. Matters once projects register by real upstream
  // owner/name — a notable repo can appear in its own scouted search results.
  // Applies whether scoped to one repo or running the global firehose.
  const ownProjects = await db
    .select({ full: schema.projectProfiles.githubFullName })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, auth.userId), eq(schema.projectProfiles.active, true)));
  for (const op of ownProjects) if (op.full) knownRepoFullNames.add(op.full.toLowerCase());

  // Punctuation-blind dep set for the exclusion check: the PyPI name
  // "segmentation-models-pytorch" must catch the repo "segmentation_models.pytorch".
  const productDepsNorm = new Set([...productDeps].map((d) => normLabel(d)));
  // An app whose centroid similarity clears this bar is "basically my whole
  // project" — a competitor, not a component. Suppressed unless it leads with a
  // specific capability (facet beats centroid by FACET_LEAD) or is a dep match.
  const COMPETITOR_CENTROID = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_COMPETITOR_CENTROID ?? "0.5")));
  const FACET_LEAD = Math.max(0, parseFloat(process.env.REPLEN_FACET_LEAD ?? "0.04"));
  // Phase 7 — capability adjacency. Surface a library from a capability the
  // project doesn't have but is NEAR (band [ADJ_LO, ADJ_HI]), labelled
  // exploratory. Only when the direct results are sparse (< ADJ_SHOW_BELOW) and
  // capped at ADJ_MAX, so it stays a "you might also explore" nudge, not noise.
  // Band tuned on real data: the floor (0.58) drops cross-domain embedding
  // noise (e.g. "technical analysis" sitting spuriously near "computer
  // vision"); the ceiling (0.85) is high on purpose — a close-but-distinct
  // neighbour like "object detection" for a CV project (~0.79) is exactly what
  // we want to surface, not exclude. "Already have it" is enforced by label
  // (ownedCapabilities), not by cosine being too high.
  const ADJ_LO = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_ADJ_LO ?? "0.58")));
  const ADJ_HI = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_ADJ_HI ?? "0.85")));
  const ADJ_MAX = Math.max(0, parseInt(process.env.REPLEN_ADJ_MAX ?? "2", 10) || 2);
  const ADJ_SHOW_BELOW = Math.max(0, parseInt(process.env.REPLEN_ADJ_SHOW_BELOW ?? "4", 10) || 4);
  // Confidence gate. The catalogue is broad, so it WILL find a plausible-looking
  // match for almost any facet — including a noisy one. If Replen's read on a
  // project is too thin (few real capability/section facets, e.g. a repo whose
  // docs are mostly AI-tooling config), don't confidently pull catalogue
  // suggestions — silence beats a confident wrong guess. Dep/stake matches and
  // the user's own targeted pool still surface; only the broad catalogue is
  // gated. (A multi-repo product unions many facets, so it clears this easily.)
  const MIN_FACETS_FOR_CATALOGUE = Math.max(0, parseInt(process.env.REPLEN_MIN_FACETS_FOR_CATALOGUE ?? "3", 10) || 3);

  // Relevance floor — "silence beats a weak match". A candidate must clear a
  // quality bar to be surfaced at all; if NONE do, the response is empty and
  // the footnote stays silent — better than interrupting with a 20%-cosine
  // macOS menu-bar app for a news site. The bar: when a cosine exists,
  // require it >= REPLEN_MIN_COSINE; otherwise a real tag/language hit
  // (relevance > 0) is the signal. Applied only on the scoped-project path
  // (where the footnote fires); zero-knowledge mode and the explicit global
  // firehose (repo='') opt out — there the user has asked to see everything.
  const MIN_COSINE = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_MIN_COSINE ?? "0.48")));
  // Headline confidence margin: a candidate clears the inventory FLOOR (so it's
  // worth keeping for opt-in triage) at projectFloor, but it only earns the
  // unsolicited "by the way" WOW line if it beats the floor by this margin. Keeps
  // the footnote trustworthy ("silence beats a weak match") without hiding the
  // data. Tunable post-deploy.
  const HEADLINE_MARGIN = Math.max(0, parseFloat(process.env.REPLEN_HEADLINE_MARGIN ?? "0.06"));
  const applyFloor = !!scopedProject && filterMode !== "zero-knowledge";
  // Calibrated floor: once a project has enough (cosine, verdict) pairs, the
  // floor moves to just under where its adoptions actually happen. Only ever
  // tightens above the global default, never loosens.
  const projectFloor = applyFloor ? await calibratedFloor(auth.userId, scopedProjectId, MIN_COSINE) : MIN_COSINE;
  // Provenance gating: a facet the server merely INFERRED from docs (or worse,
  // an ambiguous doc-section facet) is the least trustworthy kind of match
  // probe — it pays a cosine premium on top of the floor before it's allowed
  // to lead a surfaced match. Grounded/extracted facets pay nothing.
  const INFERRED_PREMIUM = Math.max(0, parseFloat(process.env.REPLEN_INFERRED_FACET_PREMIUM ?? "0.07"));
  const needsProvenancePremium = (p: Provenance | null | undefined) => p === "inferred" || p === "ambiguous";

  // "Covered" down-rank (#1 — the largest false-positive bucket in the triage
  // eval: high-cosine candidates skipped because a solution is already in place).
  // A candidate whose matched capability is already FILLED by one of the user's
  // deps (via Keystone) is redundant — penalise it. Reach grows with Keystone's
  // `fills` edges (workstream B); harmless (empty set) when sparse.
  const coveredCaps = applyFloor ? await coveredCapabilities([...productDeps]).catch(() => new Set<string>()) : new Set<string>();
  const COVERED_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_COVERED_PENALTY ?? "0.08"));
  const normForCover = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const isCovered = (facet: string | null | undefined) => !!facet && coveredCaps.size > 0 && coveredCaps.has(normForCover(facet));

  // ── Per-facet calibration + specificity (research: matching-precision §1–2) ──
  // Cosine is NOT comparable across facets: a generic facet ("optimization")
  // sits at elevated similarity against EVERYTHING, so an 0.82 match is noise;
  // a specific facet ("drone telemetry") where 0.6 is rare is a real signal. We
  // measure each facet's own noise floor — the percentile cosine it scores
  // against the actual candidate pool — and (a) require a facet-led match to
  // clear THAT floor by a margin (calibration), and (b) down-rank matches led by
  // promiscuous facets (the embedding-IDF analog). Deterministic, no model; the
  // baseline IS the facet's measured specificity. (Walmart Cosine Adapter,
  // arXiv:2408.04887.) Computed once from the pool — microseconds.
  const FACET_CAL_PCTL = Math.min(0.99, Math.max(0.5, parseFloat(process.env.REPLEN_FACET_CAL_PCTL ?? "0.85")));
  const FACET_CAL_MARGIN = Math.max(0, parseFloat(process.env.REPLEN_FACET_CAL_MARGIN ?? "0.04"));
  const FACET_IDF_WEIGHT = Math.max(0, parseFloat(process.env.REPLEN_FACET_IDF_WEIGHT ?? "0.06"));
  const FACET_CAL_MIN_POOL = Math.max(20, parseInt(process.env.REPLEN_FACET_CAL_MIN_POOL ?? "40", 10) || 40);
  // Candidate embedding by "owner/name" — collected as we score, reused for MMR
  // diversity at the output stage (so the final 3 are complementary, not 3
  // flavors of one capability). Research: matching-precision §5 (MMR).
  const vecByRepo = new Map<string, number[]>();
  const facetBaseline = new Map<string, number>(); // facet label → pool-cosine percentile (its noise floor / promiscuity)
  if (applyFloor && probeFacets.length > 0) {
    const poolVecs: number[][] = [];
    for (const c of eligible) { const v = parseStoredEmbedding(c.embedding ?? null); if (v) poolVecs.push(v); }
    if (poolVecs.length >= FACET_CAL_MIN_POOL) {
      for (const f of probeFacets) {
        const sims = poolVecs.map((v) => cosineSimilarity(f.vec, v)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
        if (sims.length) facetBaseline.set(f.label, sims[Math.min(sims.length - 1, Math.floor(sims.length * FACET_CAL_PCTL))]);
      }
    }
  }

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
    matchedProvenance: Provenance | null; // how grounded that facet is, when facet-led
    depMatch: boolean;        // Pattern A: release of a vendor this project depends on
    rank: number;             // cosine + learning boosts (sorting only; cosine stays raw)
  };
  const filtered: ScoredRow[] = [];
  // Feed sources (releases / specs / advisories) are INTENTIONALLY about deps
  // you already use — don't dep-exclude those. Regular candidates that ARE a
  // dep you already use are noise (suggesting a library you depend on).
  const isFeedSrc = (src: string) =>
    src.startsWith("stack-watch:") || src.startsWith("spec-watch:") || src.startsWith("health-watch:") || src.startsWith("security-watch:");
  for (const c of eligible) {
    const candOn = c.githubUrl ? extractOwnerName(c.githubUrl) : null;
    if (productDeps.size > 0 && !isFeedSrc(c.source) && candOn) {
      if (productDeps.has(candOn.name.toLowerCase()) || productDeps.has(candOn.owner.toLowerCase())
        || productDepsNorm.has(normLabel(candOn.name))
        || knownRepoFullNames.has(`${candOn.owner}/${candOn.name}`.toLowerCase())) continue; // already a dependency
    }
    // Recorded modality collisions for this repo: those facets are off-limits
    // as match probes (the repo can still match via other facets / centroid).
    const suppressedMods = candOn ? modalitySuppress.get(`${candOn.owner}/${candOn.name}`.toLowerCase()) : undefined;
    // Migrate-off mute: releases/news for a vendor the user is leaving.
    if (migrateOffTools.size > 0 && isFeedSrc(c.source)) {
      let candTopics: string[] = [];
      try { candTopics = c.topics ? JSON.parse(c.topics) : []; } catch { /* */ }
      if (candTopics.some((t) => typeof t === "string" && migrateOffTools.has(t.toLowerCase()))) continue;
    }
    const reasons: string[] = [];
    let relevance = 0;
    let topicHits: string[] = [];
    let langHit = false;

    if (filterMode === "zero-knowledge") {
      reasons.push("zero-knowledge mode: no per-user filter applied");
    } else {
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
        // Coarse tag pre-filter — but ONLY drop when there's no grounded embedding
        // to judge by. For an ONBOARDED project (centroid + facet vectors present),
        // a strong facet match must NOT be discarded just because the candidate
        // lacks a generic STACK tag (typescript/next.js/firebase/…). Those stack
        // tags are exactly what made well-onboarded repos surface framework-junk;
        // here we defer to the facet/centroid match + relevance floor instead, so
        // onboarding's grounded capabilities actually drive matching.
        if (!projectEmbedding && probeFacets.length === 0) continue;
        reasons.push("tag miss — deferring to facet/centroid match + floor");
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
    let matchedProvenance: Provenance | null = null;
    let facetLeadsCentroid = false; // a capability beats the whole-project match by a margin
    let candVec: number[] | null = null; // kept for the taste boost below
    if (projectEmbedding) {
      const candEmbedding = parseStoredEmbedding(c.embedding ?? null);
      candVec = candEmbedding;
      if (candEmbedding && candOn) vecByRepo.set(`${candOn.owner}/${candOn.name}`.toLowerCase(), candEmbedding);
      if (candEmbedding) {
        const cSim = cosineSimilarity(projectEmbedding, candEmbedding);
        if (Number.isFinite(cSim)) centroidCos = cSim;

        let bestFacetCos = -Infinity;
        let bestFacetLabel: string | null = null;
        let bestFacetProv: Provenance | null = null;
        for (const f of probeFacets) {
          // Contextual modality suppression: agents recorded this repo as a
          // modality collision for facets of this modality — don't probe with them.
          if (suppressedMods && f.modality?.length && f.modality.some((m) => suppressedMods.has(m))) continue;
          const fSim = cosineSimilarity(f.vec, candEmbedding);
          if (Number.isFinite(fSim) && fSim > bestFacetCos) {
            bestFacetCos = fSim;
            bestFacetLabel = f.label;
            bestFacetProv = f.provenance ?? null;
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
            matchedProvenance = bestFacetProv;
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
      c.source.startsWith("health-watch:") ? "health" :
      c.source.startsWith("security-watch:") ? "security" : null;
    if (scopedProject && scopedProjectDeps.size > 0 && stakeKind) {
      let candTopics: string[] = [];
      try { candTopics = c.topics ? JSON.parse(c.topics) : []; } catch { /* ignore */ }
      depMatch = candTopics.some((t) => typeof t === "string" && scopedProjectDeps.has(t.toLowerCase()));
      if (depMatch) {
        reasons.unshift(
          stakeKind === "spec" ? `a standard your code implements changed — ${c.title}` :
          stakeKind === "health" ? `an upstream you depend on needs attention — ${c.title}` :
          stakeKind === "security" ? `a security advisory affects a dependency you use — ${c.title}` :
          `you depend on this — new ${c.title}`,
        );
      }
    }

    // Relevance floor: drop candidates that don't clear the bar so weak
    // matches never reach the user (and an all-weak result stays silent). A
    // dependency match is exempt — it's the strongest signal we have. A match
    // LED by an inferred/ambiguous facet pays the provenance premium on top.
    if (applyFloor && !depMatch) {
      let bar = projectFloor + (matchedFacet !== null && needsProvenancePremium(matchedProvenance) ? INFERRED_PREMIUM : 0);
      // Per-facet calibration: a facet-led match must clear that facet's OWN
      // pool noise floor by a margin, not just the global floor. This is what
      // suppresses the disk-cleaner-at-0.82-on-"optimization" class — 0.82 is
      // below that promiscuous facet's calibrated bar even though it clears 0.48.
      if (matchedFacet !== null) {
        const base = facetBaseline.get(matchedFacet);
        if (base !== undefined) bar = Math.max(bar, base + FACET_CAL_MARGIN);
      }
      const clears = cosine !== null ? cosine >= bar : relevance > 0;
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

    // Rank = cosine + the learning boosts. Displayed cosine stays raw; the
    // boosts only reorder (taste, source/facet hit-rate priors, waypoint and
    // blind-spot graph hints). All zero with no history.
    let rank = cosine ?? -1;
    rank += tasteBoost(candVec, taste);
    rank += priorBoost(outcomePriors.source, sourcePrefix(c.source));
    if (isCovered(matchedFacet)) rank -= COVERED_PENALTY; // already filled by a dep
    if (matchedFacet) {
      rank += priorBoost(outcomePriors.facet, matchedFacet);
      const nf = normFacetLabel(matchedFacet);
      if (hints.waypointLabels.has(nf)) rank += WAYPOINT_BOOST;
      if (hints.unfilledLabels.has(nf)) rank += BLINDSPOT_BOOST;
      if (goalLabels.has(nf)) { rank += GOAL_BOOST; reasons.push(`advances your goal: ${matchedFacet}`); }
      // Embedding-IDF: a match led by a promiscuous facet (high pool baseline)
      // carries less information than the same cosine on a specific facet —
      // down-rank it in proportion to the facet's baseline. Displayed cosine
      // stays raw; only ordering shifts. Survivors of a generic facet sink
      // below genuine specific-capability fills.
      const base = facetBaseline.get(matchedFacet);
      if (base !== undefined) rank -= FACET_IDF_WEIGHT * base;
    }

    filtered.push({
      ...c,
      whyShortlisted: reasons.join("; ") || "candidate eligible",
      relevance,
      cosine,
      matchedFacet,
      matchedProvenance,
      depMatch,
      rank,
    });
  }

  // Sort: cosine similarity is the primary signal when available.
  // Candidates with cosine scores rank by cosine desc. Candidates
  // without cosine (lazy-backfill not yet reached them) interleave by
  // their tag-overlap relevance — they aren't penalised vs. embedded
  // ones until the embedding lands.
  filtered.sort((a, b) => {
    // Both have cosine: rank ordering (cosine + learning boosts).
    if (a.cosine !== null && b.cosine !== null) return b.rank - a.rank;
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
    src.startsWith("stack-watch:") || src.startsWith("spec-watch:") || src.startsWith("health-watch:") || src.startsWith("security-watch:");
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
    matchedProvenance?: import("@/projects/modality").Provenance | null; // how grounded that capability is
    matchedRepo?: string | null; // sibling repo it's for, when cross-repo (multi-repo products)
    promoted: boolean;
    dependencyMatch: boolean;
    projectMatch: string | null;
    // Prior-decision memory, attached server-side so the in-session agent
    // triages with history instead of from scratch: earlier verdicts on this
    // repo, and whether the matched facet is already covered by an adopt/port.
    priorContext?: string | null;
    // Risk + replacement (health/security stakes only): maintained catalogue
    // libraries similar to the flagged repo, with cross-user adoption counts.
    alternatives?: Alternative[];
  };

  // Rank per entry (cosine + learning boosts) — used by the merged sort only;
  // the JSON keeps raw cosine so the agent sees the honest similarity.
  const entryRank = new Map<OutEntry, number>();
  // Copyleft flag: fine for reading/ideas, but adopting/vendoring needs a
  // compatibility check — say so up front instead of letting the agent find
  // out at integration time.
  const isCopyleft = (license: string | null) =>
    !!license && /^(agpl|gpl|sspl)/i.test(license) && !/^lgpl/i.test(license);
  const copyleftNote = "; copyleft licence — check compatibility before adopting/vendoring";

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
    whyShortlisted: c.whyShortlisted + (isCopyleft(r!.license) ? copyleftNote : ""),
    cosine: c.cosine as number | null,
    matchedFacet: c.matchedFacet,
    matchedProvenance: c.matchedProvenance,
    promoted: false,
    dependencyMatch: c.depMatch,
    projectMatch: scopedProject?.slug ?? null,
  }));
  ownOut.forEach((e, i) => entryRank.set(e, dedup[i].c.rank));

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
      repo: on ? `${on.owner}/${on.name}` : (asString(raw?.specName) ?? asString(raw?.vendor) ?? asString(raw?.depName) ?? c.source),
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

  // Phase 5 — shared capability catalogue. Match the cross-user library
  // catalogue against this project's facets (same floor + competitor rule), so
  // a project sees the best library for each capability even when its own
  // targeted search hasn't fetched it. Only on the scoped-project path with a
  // query vector; excludes anything already surfaced from the user's own pool.
  // The scoped project's languages — for runtime-compatibility gating (don't
  // surface a Java/Android library for a Node project). Prefer the project's own
  // detected languages; fall back to the user's across-repos set.
  const projectLanguages = new Set<string>();
  try {
    const s = scopedProject?.summaryJson ? JSON.parse(scopedProject.summaryJson) : null;
    for (const l of (s?.languageSignals?.detected ?? []) as unknown[]) if (typeof l === "string") projectLanguages.add(l.toLowerCase());
  } catch { /* ignore */ }
  if (projectLanguages.size === 0) {
    for (const l of (auth.settings.detectedLanguages ?? "").split(",")) { const t = l.trim().toLowerCase(); if (t) projectLanguages.add(t); }
  }

  let catalogueOut: OutEntry[] = [];
  if (scopedProject && applyFloor && probeFacets.length >= MIN_FACETS_FOR_CATALOGUE) {
    const alreadyShown = new Set<string>(knownRepoFullNames);
    for (const o of [...ownOut, ...feedOut, ...promotedOut]) if (o.repo) alreadyShown.add(o.repo.toLowerCase());
    if (scopedProject.githubFullName) alreadyShown.add(scopedProject.githubFullName.toLowerCase());
    const matches = await catalogueMatches({
      projectEmbedding,
      projectFacets: probeFacets,
      minCosine: projectFloor,
      competitorCentroid: COMPETITOR_CENTROID,
      facetLead: FACET_LEAD,
      excludeFullNames: alreadyShown,
      projectLanguages,
      knownDeps: productDeps,
      coveredFacets,
      limit,
      tasteVec: taste,
      facetBaseline,
    });
    // Resolve repoIds (for exclusion + state-keying) where the repo is already
    // known; catalogue-only repos keep repoId null (state writes resolve by name).
    const resolved = await Promise.all(matches.map(async (m) => {
      const r = await db.select({ id: schema.repos.id }).from(schema.repos)
        .where(and(eq(schema.repos.owner, m.owner), eq(schema.repos.name, m.name))).get();
      return { m, repoId: r?.id ?? null };
    }));
    for (const { m, repoId } of resolved) {
      if (repoId !== null && excludedRepoIds.has(repoId)) continue;
      if (m.vec) vecByRepo.set(m.fullName.toLowerCase(), m.vec);
      // Contextual modality suppression: this repo collided with facets of this
      // modality before — don't surface it via such a facet again.
      if (m.matchedFacet) {
        const sup = modalitySuppress.get(m.fullName.toLowerCase());
        if (sup) {
          const mods = facetModsByLabel.get(normFacetLabel(m.matchedFacet)) ?? [];
          if (mods.some((x) => sup.has(x))) continue;
        }
      }
      // Provenance premium: an inferred/ambiguous facet must clear a higher bar
      // to pull a catalogue suggestion (the reader already nudges ranking by
      // provenance; this is the hard gate at the surfacing boundary).
      if (needsProvenancePremium(m.matchedProvenance) && m.cosine < projectFloor + INFERRED_PREMIUM) continue;
      catalogueOut.push({
        candidateId: null,
        repoId,
        repo: m.fullName,
        title: m.fullName,
        url: m.url,
        description: m.description,
        stars: m.stars,
        language: m.language,
        license: m.license,
        topics: m.topics,
        repoShape: m.repoShape,
        source: "catalogue",
        postedAt: null,
        pushedAt: null,
        whyShortlisted: (() => {
          const ageMo = m.ageDays != null ? Math.round(m.ageDays / 30) : null;
          const fit = m.matchedFacet ? `fits your ${m.matchedFacet} capability` : "semantic match";
          const pct = `${(m.cosine * 100).toFixed(0)}%`;
          const forRepo = m.matchedRepo && m.matchedRepo !== scopedProject.slug ? ` — for your \`${m.matchedRepo}\` repo` : "";
          if (m.rising && ageMo != null) return `Brainstem: rising — ${fit}, ${ageMo}mo old (${pct})${forRepo}`;
          return `Brainstem: ${fit} (${pct})${forRepo}`;
        })(),
        cosine: m.cosine,
        matchedFacet: m.matchedFacet,
        matchedProvenance: m.matchedProvenance,
        matchedRepo: m.matchedRepo && m.matchedRepo !== scopedProject.slug ? m.matchedRepo : null,
        promoted: false,
        dependencyMatch: false,
        // Attribute to the sibling repo it's actually for, so triage/handoff
        // target the right repo (multi-repo products).
        projectMatch: m.matchedRepo ?? scopedProject.slug,
      });
      const pushed = catalogueOut[catalogueOut.length - 1];
      if (isCopyleft(m.license)) pushed.whyShortlisted += copyleftNote;
      let cRank = m.cosine + (m.tasteAdj ?? 0) + priorBoost(outcomePriors.source, "catalogue");
      if (isCovered(m.matchedFacet)) cRank -= COVERED_PENALTY; // already filled by a dep
      if (m.matchedFacet) {
        cRank += priorBoost(outcomePriors.facet, m.matchedFacet);
        const nf = normFacetLabel(m.matchedFacet);
        if (hints.waypointLabels.has(nf)) cRank += WAYPOINT_BOOST;
        if (hints.unfilledLabels.has(nf)) cRank += BLINDSPOT_BOOST;
        if (goalLabels.has(nf)) { cRank += GOAL_BOOST; pushed.whyShortlisted += `; advances your goal: ${m.matchedFacet}`; }
      }
      entryRank.set(pushed, cRank);
    }
  }

  // Prior-decision context (memory in the daily loop). Each candidate carries
  // what this user already decided: earlier verdicts on the SAME repo (any
  // project), and whether the matched facet is already covered by something
  // they adopted/ported. The in-session agent gets this for free — no extra
  // tokens — and a covered candidate is down-ranked (not dropped: a materially
  // better library should still be able to surface; the agent judges that).
  const COVERED_SORT_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_COVERED_SORT_PENALTY ?? "0.06"));
  const pastTense: Record<string, string> = { adopt: "adopted", port: "ported", skip: "skipped", defer: "deferred" };
  const fmtMonth = (d: Date | null) => d ? d.toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "earlier";
  const coveredEntries = new Set<OutEntry>();
  const annotatePrior = (e: OutEntry) => {
    const notes: string[] = [];
    for (const h of prior.repoHistory.get(e.repo.toLowerCase()) ?? []) {
      notes.push(`you ${pastTense[h.verdict] ?? h.verdict} this${h.project ? ` for ${h.project}` : ""} (${fmtMonth(h.at)})${h.oneLine ? ` — ${h.oneLine}` : ""}`);
    }
    if (e.matchedFacet && !goalLabels.has(normFacetLabel(e.matchedFacet))) {
      // (goal facets are exempt — you can't already cover what you WANT)
      const cov = prior.coverage.get(normFacetLabel(e.matchedFacet));
      if (cov && cov.repo.toLowerCase() !== e.repo.toLowerCase()) {
        notes.push(`you already cover '${e.matchedFacet}' with ${cov.repo} (${pastTense[cov.verdict] ?? cov.verdict} ${fmtMonth(cov.at)}${cov.project ? ` for ${cov.project}` : ""})`);
        coveredEntries.add(e);
      }
    }
    if (notes.length) e.priorContext = notes.join("; ");
  };
  for (const e of [...ownOut, ...feedOut, ...promotedOut, ...catalogueOut]) annotatePrior(e);

  // Merge own + feed (Pattern A/B) + promoted + catalogue, rank: dependency /
  // standard stake matches first ("a thing you depend on / a standard you
  // implement just changed"), then by cosine desc (entries without a cosine
  // sink to the bottom but keep their relevance order via stable sort). Dedup by
  // repoId; repo-less feed items (chrome-status) are inherently unique and
  // always pass. Cap to limit.
  // Staleness: a non-stake candidate whose repo hasn't been pushed in 18
  // months pays a small ranking penalty — adoptability matters as much as fit.
  const STALE_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_STALE_PENALTY ?? "0.04"));
  const staleCutoff = Date.now() - 18 * 30 * 86400e3;
  const isStale = (e: OutEntry) =>
    !e.dependencyMatch && e.pushedAt != null && Date.parse(e.pushedAt) < staleCutoff;
  const rankOf = (e: OutEntry) =>
    (entryRank.get(e) ?? (e.cosine ?? -1))
    - (coveredEntries.has(e) ? COVERED_SORT_PENALTY : 0)
    - (isStale(e) ? STALE_PENALTY : 0);

  const mergedSeen = new Set<number>();
  const mergedNameSeen = new Set<string>();
  const candidatesPreMmr = [...ownOut, ...feedOut, ...promotedOut, ...catalogueOut]
    .sort((a, b) => {
      if (a.dependencyMatch !== b.dependencyMatch) return a.dependencyMatch ? -1 : 1;
      return rankOf(b) - rankOf(a);
    })
    .filter((e) => {
      // Dedup catalogue / repo-less entries by full name too (they carry no
      // repoId), so a catalogue repo can't double up with a feed item.
      if (e.repoId === null) {
        const key = e.repo.toLowerCase();
        if (mergedNameSeen.has(key)) return false;
        mergedNameSeen.add(key);
        return true;
      }
      if (mergedSeen.has(e.repoId)) return false;
      mergedSeen.add(e.repoId);
      // A catalogue entry whose repoId WAS resolved must also block a later
      // repo-less dup of the same name.
      mergedNameSeen.add(e.repo.toLowerCase());
      return true;
    });
  // MMR diversity (research: matching-precision §5). Greedily pick the top-`limit`
  // so each is relevant AND complementary — λ·rank − (1−λ)·max-similarity-to-
  // already-picked — instead of 3 near-identical libraries for one capability.
  // Dependency/stake matches keep their hard priority (picked first, in order);
  // diversity only reorders the discretionary tail. Falls back to plain order
  // for entries with no embedding. Cheap: O(n·k) cosines over in-memory vecs.
  const MMR_LAMBDA = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_MMR_LAMBDA ?? "0.7")));
  const mmrReorder = (entries: OutEntry[]): OutEntry[] => {
    if (MMR_LAMBDA >= 1 || entries.length <= 2) return entries;
    const stake = entries.filter((e) => e.dependencyMatch);
    const rest = entries.filter((e) => !e.dependencyMatch);
    if (rest.length <= 2) return entries;
    const vec = (e: OutEntry) => vecByRepo.get(e.repo.toLowerCase());
    const relOf = new Map(rest.map((e) => [e, rankOf(e)]));
    const picked: OutEntry[] = [];
    const pool = [...rest];
    while (pool.length) {
      let bestI = 0, bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const v = vec(pool[i]);
        let maxSim = 0;
        if (v) for (const p of picked) { const pv = vec(p); if (pv) maxSim = Math.max(maxSim, cosineSimilarity(v, pv)); }
        const score = MMR_LAMBDA * (relOf.get(pool[i]) ?? -1) - (1 - MMR_LAMBDA) * maxSim;
        if (score > bestScore) { bestScore = score; bestI = i; }
      }
      picked.push(pool.splice(bestI, 1)[0]);
    }
    return [...stake, ...picked];
  };
  const candidatesOut = mmrReorder(candidatesPreMmr).slice(0, limit);

  // Phase 7 — capability adjacency. When the direct results are sparse, append
  // exploratory suggestions: the best library from a capability the project
  // doesn't have but is adjacent to. Calm by construction — only fills the gap
  // up to `limit`, capped at ADJ_MAX, ranks last.
  if (scopedProject && applyFloor && probeFacets.length >= MIN_FACETS_FOR_CATALOGUE && ADJ_MAX > 0 && candidatesOut.length < ADJ_SHOW_BELOW) {
    // "Already have it" exclusion stays on the FULL facet list — adjacency
    // must never propose a capability the project has, generic or not.
    const ownedCaps = new Set(projectFacets.map((f) => f.label.toLowerCase()));
    const shownNames = new Set(candidatesOut.map((c) => c.repo.toLowerCase()));
    if (scopedProject.githubFullName) shownNames.add(scopedProject.githubFullName.toLowerCase());
    const adj = await adjacentMatches({
      projectFacets: probeFacets,
      ownedCapabilities: ownedCaps,
      projectLanguages,
      excludeFullNames: shownNames,
      adjLo: ADJ_LO,
      adjHi: ADJ_HI,
      maxCapabilities: ADJ_MAX,
      competitorCentroid: COMPETITOR_CENTROID,
      limit: ADJ_MAX,
    });
    for (const a of adj) {
      if (candidatesOut.length >= limit) break;
      const r = await db.select({ id: schema.repos.id }).from(schema.repos)
        .where(and(eq(schema.repos.owner, a.owner), eq(schema.repos.name, a.name))).get();
      if (r && excludedRepoIds.has(r.id)) continue;
      const adjEntry: OutEntry = {
        candidateId: null,
        repoId: r?.id ?? null,
        repo: a.fullName,
        title: a.fullName,
        url: a.url,
        description: a.description,
        stars: a.stars,
        language: a.language,
        license: a.license,
        topics: a.topics,
        repoShape: a.repoShape,
        source: "catalogue-adjacent",
        postedAt: null,
        pushedAt: null,
        whyShortlisted: `exploratory — adjacent to your ${a.adjacentTo}; provides ${a.adjacentCapability}`,
        cosine: a.cosine,
        matchedFacet: a.adjacentCapability,
        promoted: false,
        dependencyMatch: false,
        projectMatch: scopedProject.slug,
      };
      annotatePrior(adjEntry);
      candidatesOut.push(adjEntry);
    }
  }

  // Defer re-check (discovery mode 're-checked'). 'defer' means "not now" —
  // a promise to come back. Once a defer for THIS product has aged into the
  // re-check window and the repo is still actively developed, re-surface it.
  // Calm by construction: at most ONE per response, only when results are
  // sparse, throttled by its own long cool-off, silenced for good once the
  // window passes or the agent re-triages (any new verdict resets the clock).
  const RECHECK_MIN_DAYS = Math.max(1, parseInt(process.env.REPLEN_RECHECK_MIN_DAYS ?? "90", 10) || 90);
  const RECHECK_MAX_DAYS = Math.max(RECHECK_MIN_DAYS, parseInt(process.env.REPLEN_RECHECK_MAX_DAYS ?? "270", 10) || 270);
  const RECHECK_ACTIVE_DAYS = Math.max(1, parseInt(process.env.REPLEN_RECHECK_ACTIVE_DAYS ?? "60", 10) || 60);
  const RECHECK_COOLOFF_DAYS = Math.max(1, parseInt(process.env.REPLEN_RECHECK_COOLOFF_DAYS ?? "21", 10) || 21);
  if (scopedProject && applyFloor && candidatesOut.length < ADJ_SHOW_BELOW) {
    const rechecks = await loadDeferRechecks(auth.userId, {
      minAgeDays: RECHECK_MIN_DAYS,
      maxAgeDays: RECHECK_MAX_DAYS,
      activeWithinDays: RECHECK_ACTIVE_DAYS,
    });
    const shownNames = new Set(candidatesOut.map((c) => c.repo.toLowerCase()));
    const recheckCooloffSince = Date.now() - RECHECK_COOLOFF_DAYS * 24 * 3600 * 1000;
    for (const rc of rechecks) {
      if (candidatesOut.length >= limit) break;
      // The defer was made for this product (or has no project attribution).
      if (rc.projectSlug !== null && !productSlugs.has(rc.projectSlug)) continue;
      if (shownNames.has(rc.fullName.toLowerCase())) continue;
      if (terminalRepoIds.has(rc.repoId)) continue; // user starred/hid/handed off since
      const lastSurf = lastSurfacedByRepo.get(rc.repoId);
      if (lastSurf != null && lastSurf > recheckCooloffSince) continue;
      candidatesOut.push({
        candidateId: null,
        repoId: rc.repoId,
        repo: rc.fullName,
        title: rc.fullName,
        url: rc.url,
        description: rc.description,
        stars: rc.stars,
        language: rc.language,
        license: rc.license,
        topics: [],
        repoShape: null,
        source: "re-checked",
        postedAt: null,
        pushedAt: rc.pushedAt?.toISOString() ?? null,
        whyShortlisted: `re-check: you deferred this in ${fmtMonth(rc.deferredAt)} — it's still actively developed and may be ready now`,
        cosine: null,
        matchedFacet: null,
        promoted: false,
        dependencyMatch: false,
        projectMatch: rc.projectSlug ?? scopedProject.slug,
        priorContext: rc.oneLine ? `your note at the time: ${rc.oneLine}` : null,
      });
      break; // one re-check per response — calm cadence
    }
  }

  // Risk + replacement. A health/security stake says "this thing you depend
  // on is in trouble" — the catalogue can answer the next question in the
  // same breath: maintained, embedding-similar libraries, ranked with
  // cross-user adoption. Attached to at most two entries per response.
  let altAttached = 0;
  for (const e of candidatesOut) {
    if (altAttached >= 2) break;
    if (!e.dependencyMatch) continue;
    if (!e.source.startsWith("health-watch:") && !e.source.startsWith("security-watch:")) continue;
    if (!/^[^/]+\/[^/]+$/.test(e.repo)) continue; // repo-less feed items have nothing to compare
    try {
      const alts = await alternativesFor(e.repo, 3);
      if (alts.length) {
        e.alternatives = alts;
        e.whyShortlisted += `; maintained alternatives: ${alts.map((a) => a.fullName).join(", ")}`;
        altAttached++;
      }
    } catch (err) {
      console.warn(`[inventory] alternatives lookup failed for ${e.repo} (non-fatal):`, err);
    }
  }

  // Pre-formatted user-facing footnote string. Built server-side so the
  // agent doesn't have to derive it from the JSON (which has historically
  // been the unreliable bit — agents inconsistently formatted or skipped
  // it). The MCP server surfaces this directly under a USER-FACING
  // MESSAGE block in its tool response, with the tool description
  // instructing the agent to relay it verbatim.
  let displayText: string | null = null;
  // Headline confidence gate (#1 — "silence beats a weak match"). Only let a
  // candidate become the unsolicited footnote when it's genuinely worth the
  // interruption. The candidate DATA below is still returned for opt-in triage —
  // we're gating the WOW line, not hiding results. When this suppresses the
  // headline, the quiet-day leap path below takes over (#2 — a high-confidence
  // cross-project leap beats a weak candidate). Rules: dependency/spec/security
  // matches and deliberate re-checks always qualify (high-signal regardless of
  // cosine); exploratory adjacency NEVER headlines (it's speculative — this was
  // the Turing.jl-on-a-CV-repo false positive); a facet match must clear the
  // floor by HEADLINE_MARGIN, a bare-semantic match by 2× (it's the weakest fit).
  const headlineTop = candidatesOut[0];
  const headlineWorthy = !!(headlineTop && scopedProject && (
    headlineTop.dependencyMatch === true ||
    headlineTop.source === "re-checked" ||
    (headlineTop.source !== "catalogue-adjacent" && (
      headlineTop.matchedFacet
        ? (headlineTop.cosine ?? 0) >= projectFloor + HEADLINE_MARGIN
        : (headlineTop.cosine ?? 0) >= projectFloor + 2 * HEADLINE_MARGIN
    ))
  ));
  if (headlineWorthy) {
    const top = candidatesOut[0];
    if (top.dependencyMatch) {
      // Pattern A/B lead: a vendor the project depends on shipped, or a
      // standard the project implements changed.
      const lead = top.source.startsWith("spec-watch:")
        ? `a standard your code implements just changed — ${top.title}`
        : top.source.startsWith("health-watch:")
        ? `an upstream you depend on needs attention — ${top.title}`
        : top.source.startsWith("security-watch:")
        ? `a security advisory affects a dependency you use — ${top.title}`
        : `a dependency you use just shipped — ${top.title}`;
      // Risk + replacement in one breath: when the stake is bad news about an
      // upstream and the catalogue knows maintained stand-ins, say so.
      const altNote = top.alternatives?.length
        ? ` Maintained alternatives exist (${top.alternatives.slice(0, 2).map((a) => `\`${a.fullName}\``).join(", ")}).`
        : "";
      displayText = `By the way — ${lead}.${altNote} ${candidatesOut.length} Replen candidate${candidatesOut.length === 1 ? "" : "s"} queued for this repo — want me to triage them?`;
    } else if (top.source === "catalogue-adjacent") {
      // Exploratory adjacency: a capability the project doesn't have but is
      // near. Frame it as a suggestion, not a fit.
      const topDesc = top.description ? ` — ${clipDesc(top.description, 70)}` : "";
      displayText = `By the way — \`${top.repo}\` could add ${top.matchedFacet} to this project (adjacent to what you already do)${topDesc}. ${candidatesOut.length} Replen suggestion${candidatesOut.length === 1 ? "" : "s"} for this repo — want me to take a look?`;
    } else if (top.source === "re-checked") {
      // Re-check lead: the deferred repo is the only/strongest thing today.
      displayText = `By the way — you deferred \`${top.repo}\` a while back ("not now"); it's still actively developed and may be ready. Want me to take a fresh look?`;
    } else if (top.matchedFacet) {
      // Facet-led: surface WHICH capability it fills, not a bare "% match".
      // This is the component-fit framing — "helps with your X" rather than
      // "looks like your project" (which would be a competitor).
      const topDesc = top.description ? ` — ${clipDesc(top.description, 70)}` : "";
      // Multi-repo: attribute to the sibling repo it's actually for.
      const forWhat = top.matchedRepo ? `your \`${top.matchedRepo}\` repo's ${top.matchedFacet}` : `your ${top.matchedFacet}`;
      displayText = `By the way — \`${top.repo}\` could help with ${forWhat}${topDesc}. ${candidatesOut.length} Replen candidate${candidatesOut.length === 1 ? "" : "s"} queued for this repo — want me to triage them?`;
    } else {
      const simStr = typeof top.cosine === "number" ? ` (~${Math.round(top.cosine * 100)}% match)` : "";
      const topDesc = top.description ? ` — ${clipDesc(top.description, 80)}` : "";
      displayText = `By the way — ${candidatesOut.length} Replen candidate${candidatesOut.length === 1 ? "" : "s"} queued for this repo. Top: \`${top.repo}\`${simStr}${topDesc}. Want me to triage them?`;
    }
  }

  // Feature log (#5): one row per surfaced candidate, capturing the features that
  // fed its rank + whether it headlined. Joined to triage_events later (by
  // full_name + user/project) it yields (features → verdict) training rows — the
  // prerequisite for a true full-rank eval replay and for the learned ranker (A).
  // Best-effort, never blocks the response; only on the scoped-project path.
  if (candidatesOut.length > 0 && scopedProject) {
    try {
      const now = new Date();
      await db.insert(schema.matchFeatures).values(candidatesOut.map((c, i) => ({
        userId: auth.userId,
        projectId: scopedProjectId ?? null,
        fullName: c.repo.toLowerCase(),
        surfacedAt: now,
        cosine: typeof c.cosine === "number" ? c.cosine : null,
        matchedFacet: c.matchedFacet ?? null,
        facetModality: null,
        matchedProvenance: c.matchedProvenance ?? null,
        source: c.source ?? null,
        repoShape: c.repoShape ?? null,
        stars: typeof c.stars === "number" ? c.stars : null,
        language: c.language ?? null,
        depMatch: !!c.dependencyMatch,
        covered: isCovered(c.matchedFacet),
        position: i,
        headlined: i === 0 && headlineWorthy,
      })));
    } catch (e) { console.warn("[inventory] match-feature log failed (non-fatal):", e); }
  }

  // Quiet-day leap. When the inventory has NOTHING for this repo, occasionally
  // surface the top graph leap (cross-project transfer / adjacency / cross-user
  // endorsement) instead of pure silence. Tightly budgeted — at most one per
  // project per REPLEN_LEAP_QUIET_DAYS, never the same leap twice — so quiet
  // months still deliver one portfolio insight without breaking calm cadence.
  let leapOut: Leap | null = null;
  if (!displayText && scopedProject && scopedProjectId && applyFloor) {
    const LEAP_QUIET_DAYS = Math.max(1, parseInt(process.env.REPLEN_LEAP_QUIET_DAYS ?? "30", 10) || 30);
    const leapKey = (l: Leap) => `${l.kind}:${l.capability}:${l.candidate ?? ""}`;
    const past = await db
      .select({ leapKey: schema.leapSurfaces.leapKey, surfacedAt: schema.leapSurfaces.surfacedAt })
      .from(schema.leapSurfaces)
      .where(and(
        eq(schema.leapSurfaces.userId, auth.userId),
        eq(schema.leapSurfaces.projectId, scopedProjectId),
      ));
    const budgetSince = Date.now() - LEAP_QUIET_DAYS * 24 * 3600 * 1000;
    const withinBudget = !past.some((p) => p.surfacedAt.getTime() > budgetSince);
    if (withinBudget) {
      const seenKeys = new Set(past.map((p) => p.leapKey));
      try {
        // Practice-transfer FIRST — the highest-value quiet-day insight: a
        // structural move (Keystone practice) another portfolio project makes
        // that this adjacent one doesn't. Shares the leap budget + dedup.
        const transfers = await suggestPracticeTransfer(auth.userId, scopedProject.slug);
        const ptKey = (t: { practice: string; fromProject: string }) => `practice:${normFacetLabel(t.practice)}:${t.fromProject}`;
        const pt = transfers.find((t) => !seenKeys.has(ptKey(t)));
        if (pt) {
          displayText = `Nothing new for this repo today — but a portfolio pattern: \`${pt.fromProject}\` uses **${pt.practice}** (${clipDesc(pt.description, 110)}). This project is close enough that it might fit here too — want me to look at whether it'd help?`;
          await db.insert(schema.leapSurfaces).values({ userId: auth.userId, projectId: scopedProjectId, leapKey: ptKey(pt), surfacedAt: new Date() });
        } else {
          const leaps = await computeLeaps(auth.userId, { scopeProject: scopedProject.slug, limit: 6 });
          const pick = leaps.find((l) => !seenKeys.has(leapKey(l)));
          if (pick) {
            leapOut = pick;
            displayText = `Nothing new for this repo today — but a connection from your portfolio: ${pick.via}. Want me to take a look?`;
            await db.insert(schema.leapSurfaces).values({
              userId: auth.userId,
              projectId: scopedProjectId,
              leapKey: leapKey(pick),
              surfacedAt: new Date(),
            });
          }
        }
      } catch (e) {
        console.warn("[inventory] quiet-day leap failed (non-fatal):", e);
      }
    }
  }

  // Keystone upgrades for this project's reported solutions (task-scoped
  // better_than edges) — computed in the awareness block below, reused in the
  // response. Declared here so both see it.
  let keystoneUpgrades: Awaited<ReturnType<typeof suggestUpgrades>> = [];
  // Awareness line — pricing watch + announcement layer, AT MOST ONE per
  // response, each shown once per user ever. Severity decides placement and
  // priority: a Critical announcement (exploited CVE, breach, malicious
  // package affecting a tool this product uses) LEADS the footnote; otherwise
  // a pricing change wins (concrete, actionable), then any other qualifying
  // announcement as a P.s. Both match via the same deps+tags token contract,
  // and announcements additionally pass the four-questions gate server-side.
  if (scopedProject) {
    try {
      const userTokens = pricingUserTokens(productDeps, userTagSet);
      const [pricing, announcement, deadline] = await Promise.all([
        pricingPs(auth.userId, userTokens),
        announcementPs(auth.userId, userTokens),
        deadlinePs(auth.userId, userTokens),
      ]);
      // Keystone upgrade — a solution this project uses has a better_than edge.
      // Lowest-priority calm line (improve-when-you-can, not time-sensitive like
      // security/EOL/billing), surfaced at most once per (project, upgrade).
      // Match against reported deps (libraries/services) AND the project's
      // capability terms (algorithms are captured as capabilities, e.g.
      // "weighted knn") — facets are the cleaned/matchable set, but capability
      // TAGS hold the full list (algorithms often live only there), so include
      // both. One better_than query covers library swaps + algorithm upgrades.
      let capTags: string[] = [];
      if (scopedProject?.summaryJson) {
        try { const s = JSON.parse(scopedProject.summaryJson) as { capabilityTags?: string[] }; capTags = Array.isArray(s.capabilityTags) ? s.capabilityTags.filter((t): t is string => typeof t === "string") : []; } catch { /* */ }
      }
      // Keystone upgrades are a PER-REPO judgment: probe only THIS repo's own
      // deps + facets + capability tags, never the product-wide union. An
      // algorithm/library that lives in one sibling (a-star in the routing repo)
      // must not fire its upgrade on every product member (the log parser, the
      // telemetry collector, the marketing site) — that was the loudest noise
      // source. productDeps/projectFacets stay product-wide for candidate
      // matching; the upgrade probe is deliberately narrower.
      const scopedDepProbe = scopedProject
        ? new Set<string>([...parseTechSummaryDeps(scopedProject.techSummary ?? null), ...parseDepVersionNames(scopedProject.depVersions ?? null)])
        : new Set<string>();
      const scopedFacetLabels = projectFacets
        .filter((f) => { const r = (f as { repo?: string }).repo; return !r || r === scopedProject?.slug; })
        .map((f) => f.label);
      const upgradeProbe = scopedProject ? [...scopedDepProbe, ...scopedFacetLabels, ...capTags] : [];
      keystoneUpgrades = upgradeProbe.length > 0 ? await suggestUpgrades(upgradeProbe).catch(() => []) : [];
      let keystoneUp: typeof keystoneUpgrades[number] | null = null;
      if (keystoneUpgrades.length > 0 && scopedProjectId) {
        const seen = new Set((await db.select({ k: schema.keystoneSurfaces.upgradeKey }).from(schema.keystoneSurfaces)
          .where(and(eq(schema.keystoneSurfaces.userId, auth.userId), eq(schema.keystoneSurfaces.projectId, scopedProjectId)))).map((r) => r.k));
        keystoneUp = keystoneUpgrades.find((u) => !seen.has(`${u.current}->${u.better}`)) ?? null;
      }
      const nowTs = new Date();
      const recordAnnouncement = (eventId: number) => db.insert(schema.announcementSurfaces)
        .values({ userId: auth.userId, eventId, surfacedAt: nowTs }).onConflictDoNothing();
      const recordDeadline = (deadlineId: number, phase: string) => db.insert(schema.deadlineSurfaces)
        .values({ userId: auth.userId, deadlineId, phase, surfacedAt: nowTs }).onConflictDoNothing();
      const recordPricing = (changeId: number) => db.insert(schema.pricingSurfaces)
        .values({ userId: auth.userId, changeId, surfacedAt: nowTs }).onConflictDoNothing();
      // Atlas deep link — when the flagged tool exists as a node in the
      // user's graph, the line can answer the obvious follow-up ("where do
      // I use this?") with a click: Atlas opens focused on that tool, its
      // USES edges lit. Still one line; the link rides on the end.
      const atlasLink = async (token: string | null | undefined): Promise<string> => {
        if (!token) return "";
        const tn = await db.select({ id: schema.graphNodes.id }).from(schema.graphNodes)
          .where(and(
            eq(schema.graphNodes.userId, auth.userId),
            eq(schema.graphNodes.kind, "tool"),
            sql`LOWER(${schema.graphNodes.nodeKey}) = ${token.toLowerCase()}`,
          )).get();
        if (!tn) return "";
        const base = (process.env.CLI_PUBLIC_BASE_URL ?? "https://app.replen.dev").replace(/\/+$/, "");
        return ` Where you use it: ${base}/atlas?node=${encodeURIComponent(`tool:${token.toLowerCase()}`)}`;
      };
      const appendPs = (line: string) => {
        displayText = displayText ? `${displayText}\n\nP.s. ${line}` : `P.s. ${line}`;
      };
      // Priority: Critical announcement (leads) > deadline this week >
      // pricing change > deadline reminder/announce > other announcement.
      if (announcement?.critical) {
        const lead = `${announcement.line}${await atlasLink(announcement.token)}`;
        displayText = displayText ? `${lead}\n\n${displayText}` : lead;
        await recordAnnouncement(announcement.eventId);
      } else if (deadline?.urgent) {
        appendPs(`${deadline.line}${await atlasLink(deadline.token)}`);
        await recordDeadline(deadline.deadlineId, deadline.phase);
      } else if (pricing) {
        appendPs(`${pricing.line}${await atlasLink(pricing.token)}`);
        await recordPricing(pricing.changeId);
      } else if (deadline) {
        appendPs(`${deadline.line}${await atlasLink(deadline.token)}`);
        await recordDeadline(deadline.deadlineId, deadline.phase);
      } else if (announcement) {
        appendPs(`${announcement.line}${await atlasLink(announcement.token)}`);
        await recordAnnouncement(announcement.eventId);
      } else if (keystoneUp && scopedProjectId) {
        const u = keystoneUp;
        const why = u.source ? ` (${u.source})` : "";
        // Algorithm upgrades are CONDITIONAL (the task names the condition; the
        // user may have chosen the simpler one deliberately) — frame them softer
        // than a library swap or model pick.
        const line = u.betterKind === "algorithm"
          ? `\`${scopedProject!.slug}\` uses \`${u.current}\` — \`${u.better}\` is typically the stronger approach for ${u.task}${why}.`
          : `\`${scopedProject!.slug}\` uses \`${u.current}\` — \`${u.better}\` is the better ${u.betterKind === "hosted_model" ? "model" : "swap"} for ${u.task}${why}.`;
        appendPs(line);
        await db.insert(schema.keystoneSurfaces)
          .values({ userId: auth.userId, projectId: scopedProjectId, upgradeKey: `${u.current}->${u.better}`, surfacedAt: nowTs })
          .onConflictDoNothing();
      }
    } catch (e) {
      console.warn("[inventory] awareness line failed (non-fatal):", e);
    }
  }

  // Click-to-queue, the surfacing half: pending queued work (from brief/alert
  // links or replen_queue) rides into the session. The full list goes in the
  // JSON for the agent; the footnote reminds about ONE item, at most once a
  // day, until it's done or dismissed.
  let queuedOut: Array<{ id: number; kind: string; title: string; note: string | null; project: string | null; queuedAt: string }> = [];
  if (scopedProject) {
    try {
      const allPending = await db.select().from(schema.queuedActions)
        .where(and(eq(schema.queuedActions.userId, auth.userId), eq(schema.queuedActions.status, "queued")))
        .orderBy(asc(schema.queuedActions.createdAt));
      // Project routing: an item queued FOR a project only surfaces in
      // sessions scoped to that project (or its product siblings); items
      // with no project are fair game in any repo.
      const pending = allPending.filter((q) => q.projectSlug == null || productSlugs.has(q.projectSlug));
      queuedOut = pending.map((q) => ({
        id: q.id, kind: q.kind, title: q.title, note: q.note,
        project: q.projectSlug, queuedAt: q.createdAt.toISOString(),
      }));
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const due = pending.find((q) => !q.lastRemindedAt || q.lastRemindedAt.getTime() < dayAgo);
      if (due) {
        const more = pending.length > 1 ? ` (+${pending.length - 1} more queued)` : "";
        const remindLine = `Also — you queued “${due.title}”${due.kind !== "custom" ? " from your brief" : ""}${more}. Want me to handle it now?`;
        displayText = displayText ? `${displayText}\n\n${remindLine}` : remindLine;
        await db.update(schema.queuedActions).set({ lastRemindedAt: new Date() })
          .where(eq(schema.queuedActions.id, due.id));
      }
    } catch (e) {
      console.warn("[inventory] queued-actions reminder failed (non-fatal):", e);
    }
  }

  // Product thesis — what this project is trying to BE + where it's heading.
  // Handed to the in-session agent so it triages candidates against the MISSION
  // ("does this advance a contested-airspace decision-support platform?"), not
  // just the tech slots. The richest, cheapest relevance signal we have — and a
  // far better false-positive filter than cosine. Null until onboarding fills it.
  let projectThesis: { purpose: string | null; goals: string[] } | null = null;
  if (scopedProject?.summaryJson) {
    try {
      const s = JSON.parse(scopedProject.summaryJson) as { purpose?: string; outcomeGoals?: Array<{ statement?: string }> };
      const purpose = typeof s.purpose === "string" && s.purpose.trim() ? s.purpose.trim() : null;
      const goals = Array.isArray(s.outcomeGoals)
        ? s.outcomeGoals.map((g) => g?.statement).filter((g): g is string => typeof g === "string" && !!g.trim())
        : [];
      if (purpose || goals.length) projectThesis = { purpose, goals };
    } catch { /* ignore */ }
  }

  // keystoneUpgrades computed in the awareness block above (the better_than
  // upgrades for this project's reported solutions, task-scoped).
  return NextResponse.json(
    {
      filterMode,
      scopedTo: scopedProject ? `${scopedProject.slug} (${scopedProject.githubFullName})` : null,
      // What the project is trying to BE — triage candidates against this, not
      // just the capability slots. Null until onboarding captures it.
      projectThesis,
      // Keystone: better_than upgrades for solutions this project uses (task-scoped).
      keystoneUpgrades,
      productRepos: productRepoCount, // repos in this product whose capabilities are unioned
      days,
      windowReason,
      minCosine: applyFloor ? projectFloor : null,
      totalConsidered,
      afterEligibility,
      afterFilter,
      returned: candidatesOut.length,
      displayText: withUpgradeNudge(displayText, upgradeNudge),
      candidates: candidatesOut,
      // Quiet-day leap (when set, displayText already carries its message).
      leap: leapOut,
      // Pending queued work (from brief/alert links or replen_queue). The
      // agent handles items the user accepts, then resolves via replen_queue.
      queuedActions: queuedOut,
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
