import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
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
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "2", 10) || 2, 1), 30);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);
  const repoFilter = url.searchParams.get("repo")?.trim().toLowerCase() || null;

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
    if (p) {
      scopedProjectId = p.id;
      scopedProject = p;
    } else {
      // The cwd's repo isn't a known project. Stay silent on the inventory
      // — surfacing matches for unrelated projects when the agent opens in
      // /tmp or someone's dotfiles is noise. The caller can pass repo=''
      // explicitly to override.
      return NextResponse.json(
        {
          filterMode,
          scopedTo: repoFilter,
          days,
          totalConsidered: 0,
          afterEligibility: 0,
          afterFilter: 0,
          candidates: [],
          note: "repo not in your project list; pass repo='' for the global firehose",
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

  // Excluded set: repos the user has already engaged with (starred /
  // hidden / handed_off). Surfacing these again would be noise.
  const stateRows = await db
    .select({ repoId: schema.userMatchState.repoId })
    .from(schema.userMatchState)
    .where(and(
      eq(schema.userMatchState.userId, auth.userId),
      inArray(schema.userMatchState.status, ["starred", "hidden", "handed_off"]),
    ));
  const excludedRepoIds = new Set(stateRows.map((r) => r.repoId));

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
