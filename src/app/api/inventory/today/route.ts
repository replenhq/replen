import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { checkEligibility } from "@/analyzer/eligibility";
import type { RepoShape } from "@/fetchers/repo-shape";
import { cosineSimilarity, parseStoredEmbedding } from "@/lib/embeddings";

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
  // Otherwise the window adapts to the user's history: a brand-new user (no
  // prior match-state at all) gets a wide FIRST-RUN window so their very
  // first match has months of inventory to pull from — the good per-project
  // `gh-targeted:*` candidates are often days-to-weeks old and a 2-day
  // window amputates them, making the matcher look empty/broken. Established
  // users get a steady ~week so the footnote stays "what's new" rather than
  // re-litigating old candidates. Both are env-tunable.
  const FIRSTRUN_DAYS = Math.min(365, Math.max(1, parseInt(process.env.REPLEN_FIRSTRUN_DAYS ?? "180", 10) || 180));
  const STEADY_DAYS = Math.min(90, Math.max(1, parseInt(process.env.REPLEN_STEADY_DAYS ?? "7", 10) || 7));
  const explicitDays = url.searchParams.get("days");
  let days: number;
  let windowReason: string;
  if (explicitDays !== null && explicitDays.trim() !== "") {
    days = Math.min(365, Math.max(1, parseInt(explicitDays, 10) || STEADY_DAYS));
    windowReason = "explicit";
  } else {
    // First-run detection is user-level: "have we ever served this user any
    // inventory they engaged with?" One indexed existence check.
    const prior = await db
      .select({ id: schema.userMatchState.id })
      .from(schema.userMatchState)
      .where(eq(schema.userMatchState.userId, auth.userId))
      .limit(1);
    const firstRun = prior.length === 0;
    days = firstRun ? FIRSTRUN_DAYS : STEADY_DAYS;
    windowReason = firstRun ? "first-run" : "steady";
  }

  const filterMode = (auth.settings.filterMode ?? "tags") as "zero-knowledge" | "tags" | "fingerprint";

  // Resolve the project scope. When ?repo=owner/name is set we scope
  // to the matching projectProfile (and its tags, for filter mode
  // 'tags'). When unset, we operate user-wide and intersect tags
  // across all the user's projects.
  let scopedProjectId: number | null = null;
  let scopedProject: typeof schema.projectProfiles.$inferSelect | null = null;
  if (repoFilter) {
    const p = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, auth.userId),
        sql`LOWER(${schema.projectProfiles.githubFullName}) = ${repoFilter}`,
      ))
      .get();
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
            : "repo not in your project list; pass repo='' for the global firehose",
        },
        { headers: corsHeaders },
      );
    }
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

  // Relevance floor — "silence beats a weak match". A candidate must clear a
  // quality bar to be surfaced at all; if NONE do, the response is empty and
  // the footnote stays silent — better than interrupting with a 20%-cosine
  // macOS menu-bar app for a news site. The bar: when a cosine exists,
  // require it >= REPLEN_MIN_COSINE; otherwise a real tag/language hit
  // (relevance > 0) is the signal. Applied only on the scoped-project path
  // (where the footnote fires); zero-knowledge mode and the explicit global
  // firehose (repo='') opt out — there the user has asked to see everything.
  const MIN_COSINE = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_MIN_COSINE ?? "0.4")));
  const applyFloor = !!scopedProject && filterMode !== "zero-knowledge";

  type ScoredRow = CandidateRow & {
    whyShortlisted: string;
    relevance: number;        // tag-overlap fallback score
    cosine: number | null;    // semantic similarity (null when unavailable)
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
    let cosine: number | null = null;
    if (projectEmbedding) {
      const candEmbedding = parseStoredEmbedding(c.embedding ?? null);
      if (candEmbedding) {
        const sim = cosineSimilarity(projectEmbedding, candEmbedding);
        if (Number.isFinite(sim)) {
          cosine = sim;
          reasons.push(`semantic similarity: ${(sim * 100).toFixed(0)}%`);
        }
      }
    }

    // Relevance floor: drop candidates that don't clear the bar so weak
    // matches never reach the user (and an all-weak result stays silent).
    if (applyFloor) {
      const clears = cosine !== null ? cosine >= MIN_COSINE : relevance > 0;
      if (!clears) continue;
    }

    filtered.push({
      ...c,
      whyShortlisted: reasons.join("; ") || "candidate eligible",
      relevance,
      cosine,
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

  // Join repos for richer metadata; resolve once per repo via single IN-query.
  const repoIds = [...new Set(filtered.map((c) => c.githubUrl ? null : null).filter(Boolean))];
  void repoIds; // not used yet — candidate.githubUrl already carries owner/name, but joining repos
  // would give us stars/license/topics from the canonical record. Defer until repos table is
  // consistently populated for every candidate (today only some sources populate it).

  // Apply excluded-repo filter via the candidates' resolved owner/name → repo lookup.
  // For now: do a per-candidate lookup against the repos table for the rich fields.
  const ownerNamePairs = filtered
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

  // Build the response.
  const candidatesOut = dedup
    .slice(0, limit)
    .map(({ c, r }) => ({
      candidateId: c.id,
      repoId: r!.id,
      repo: `${r!.owner}/${r!.name}`,
      url: r!.url,
      description: r!.description,
      stars: r!.stars,
      language: r!.primaryLanguage,
      license: r!.license,
      topics: c.topics ? safeParseJsonArray(c.topics) : [],
      repoShape: c.repoShape,
      source: c.source,
      postedAt: c.postedAt?.toISOString() ?? null,
      pushedAt: r!.pushedAt?.toISOString() ?? null,
      whyShortlisted: c.whyShortlisted,
      projectMatch: scopedProject?.slug ?? null,
    }));

  // Pre-formatted user-facing footnote string. Built server-side so the
  // agent doesn't have to derive it from the JSON (which has historically
  // been the unreliable bit — agents inconsistently formatted or skipped
  // it). The MCP server surfaces this directly under a USER-FACING
  // MESSAGE block in its tool response, with the tool description
  // instructing the agent to relay it verbatim.
  let displayText: string | null = null;
  if (candidatesOut.length > 0 && scopedProject) {
    const top = candidatesOut[0];
    const simMatch = top.whyShortlisted.match(/semantic similarity:\s*(\d+)%/);
    const simStr = simMatch ? ` (~${simMatch[1]}% match)` : "";
    const topDesc = top.description ? ` — ${top.description.slice(0, 80).replace(/\.$/, "")}` : "";
    displayText = `By the way — ${candidatesOut.length} Replen candidate${candidatesOut.length === 1 ? "" : "s"} queued for this repo. Top: \`${top.repo}\`${simStr}${topDesc}. Want me to triage them?`;
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
