import { db, schema } from "../db/client";
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { scanRepo, type SafetyReport } from "../scanner/safety";
import { triage } from "./triage";
import { reasonAboutRepo, renderWriteup } from "./reason";
import { scoreTargetedCandidate, type TargetedAttribution } from "./score-targeted";
import { scoreWithSourceVerification } from "./source-context";
import { scoreBookmarkAgainstProject } from "./resurface";
import { readRunOrEnv } from "./run-context";
import type { ProjectSummary } from "../projects/summarize";
import { discoverLocalProjects, upsertProjects, type LocalProject } from "../projects/loader";
import { shouldSkip as shouldSkipBigCo } from "../fetchers/big-co";
import { getSourceQualityWeights, parseTrendingMembership, sourceKind as sourceKindOf, sourceRank } from "../lib/source-rank";
import type { UserConfig } from "../scheduler/user-config";
import { withRunConfig } from "./run-context";
import { recordEvent } from "../scheduler/events";
import { LlmQuotaError } from "./llm";

const HOURS = 36;

export async function runAnalysis(
  runId: number,
  userId: number,
  cfg: UserConfig
): Promise<{ reposAnalyzed: number; matchesCreated: number }> {
  // Carry per-user config via AsyncLocalStorage; mutating process.env raced
  // concurrent runs and could leak user A's API key to user B's base URL.
  return withRunConfig(
    {
      llmPrimaryApiKey: cfg.llmPrimaryApiKey,
      llmPrimaryBaseUrl: cfg.llmPrimaryBaseUrl,
      llmPrimaryModel: cfg.llmPrimaryModel,
      llmSensitiveApiKey: cfg.llmSensitiveApiKey,
      llmSensitiveBaseUrl: cfg.llmSensitiveBaseUrl,
      llmSensitiveModel: cfg.llmSensitiveModel,
      llmSensitiveWireFormat: cfg.llmSensitiveWireFormat,
      deepseekApiKey: cfg.deepseekApiKey,
      anthropicApiKey: cfg.anthropicApiKey,
      githubToken: cfg.githubToken,
    },
    () => runAnalysisInner(runId, userId)
  );
}

async function runAnalysisInner(runId: number, userId: number) {
  const githubRoot = process.env.GITHUB_ROOT ?? process.cwd();
  const settings = await db
    .select({ extraDocPaths: schema.userSettings.extraDocPaths })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  const extraDocPaths = (settings?.extraDocPaths ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const discovered = await discoverLocalProjects(githubRoot, { extraDocPaths });
  await upsertProjects(discovered, userId);
  // Read back THIS USER's project rows so included/sensitivity flags apply.
  const dbProjects = await db
    .select()
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  const projectsForReasoning: LocalProject[] = dbProjects.map((p) => ({
    slug: p.slug,
    path: p.path,
    name: p.name,
    readmeMd: p.readmeMd,
    claudeMd: p.claudeMd,
    techSummary: p.techSummary,
    profileHash: p.profileHash,
    active: !!p.active,
    included: !!p.included,
    sensitivity: (p.sensitivity as "low" | "high") ?? "low",
    llmProvider: (p.llmProvider as "auto" | "deepseek" | "anthropic") ?? "auto",
  }));
  const projectIdBySlug = new Map(dbProjects.map((p) => [p.slug, p.id]));

  const since = new Date(Date.now() - HOURS * 3600 * 1000);
  const cands = await db
    .select()
    .from(schema.candidates)
    .where(and(eq(schema.candidates.userId, userId), gte(schema.candidates.fetchedAt, since), isNotNull(schema.candidates.githubUrl)))
    .orderBy(desc(schema.candidates.score));

  const weights = await getSourceQualityWeights(userId);

  // Pick best source per repo (lowest sourceRank wins) so the match credits
  // the richest-media discovery (TikTok beats gh-trending, etc.).
  const bestSourceByKey = new Map<string, string>();
  const scoreByKey = new Map<string, number>();
  // Trending window membership per repo, captured at candidate-collection
  // time so reason.ts can surface "appeared on daily+weekly+monthly" as a
  // signal to the LLM. Keyed by lowercase "owner/name" same as scoreByKey.
  const trendingWindowsByKey = new Map<string, string[]>();
  const targets: { owner: string; name: string; key: string }[] = [];
  // gh-targeted attribution per repo. When a repo was surfaced by Stage 3
  // we already know which project + outcome it's meant to serve. Stage 4
  // (score-targeted.ts) uses this to skip the existing shortlist pass and
  // ask a sharper question: "does this repo serve outcome X for project Y?".
  type AttribWithProjectId = TargetedAttribution & { projectId: number };
  const targetedAttribByKey = new Map<string, AttribWithProjectId[]>();
  for (const c of cands) {
    const m = c.githubUrl?.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
    if (!m) continue;
    const key = `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
    const kind = sourceKindOf(c.source);
    const prev = bestSourceByKey.get(key);
    if (!prev || sourceRank(kind) < sourceRank(prev)) bestSourceByKey.set(key, kind);
    // Weight candidate score by source feedback quality (default 1.0).
    // For gh-trending candidates, also apply the breadth-of-window multiplier
    // so all-three-windows repos rank above daily-only when the queue is full.
    // The multiplier defaults to 1.0 for non-trending sources / older rows.
    const baseScore = c.score ?? 0;
    const membership = parseTrendingMembership(c.source, c.rawJson);
    const trendingMult = membership?.multiplier ?? 1.0;
    const weighted = baseScore * (weights.get(kind) ?? 1.0) * trendingMult;
    const prevScore = scoreByKey.get(key) ?? -Infinity;
    if (weighted > prevScore) scoreByKey.set(key, weighted);
    if (membership && !trendingWindowsByKey.has(key)) {
      trendingWindowsByKey.set(key, membership.windows);
    }
    if (!targets.find((x) => x.key === key)) {
      targets.push({ owner: m[1], name: m[2].replace(/\.git$/, ""), key });
    }
    // Capture Stage-3 attribution (gh-targeted:<slug> sources only).
    if (c.source.startsWith("gh-targeted:") && c.rawJson) {
      try {
        const raw = JSON.parse(c.rawJson) as {
          projectId?: number;
          outcome?: string;
          outcomeSource?: string;
          outcomeConfidence?: string;
          matchedTerm?: string;
        };
        if (
          typeof raw.projectId === "number" &&
          typeof raw.outcome === "string" &&
          (raw.outcomeSource === "user" || raw.outcomeSource === "inferred") &&
          (raw.outcomeConfidence === "high" || raw.outcomeConfidence === "medium")
        ) {
          const arr = targetedAttribByKey.get(key) ?? [];
          arr.push({
            projectId: raw.projectId,
            outcome: raw.outcome,
            outcomeSource: raw.outcomeSource,
            outcomeConfidence: raw.outcomeConfidence,
            matchedTerm: typeof raw.matchedTerm === "string" ? raw.matchedTerm : "",
          });
          targetedAttribByKey.set(key, arr);
        }
      } catch {
        // Malformed raw: just skip the attribution; the repo can still be
        // processed via the general analyzer path if other candidates pull it in.
      }
    }
  }
  // Reorder targets by their best weighted score, descending.
  targets.sort((a, b) => (scoreByKey.get(b.key) ?? 0) - (scoreByKey.get(a.key) ?? 0));

  // Skip-actioned filter: if the user has already starred, bookmarked, hidden,
  // integrated, or opened a handoff PR for a repo, don't re-analyse it on the
  // discovery path. Saves LLM cost and avoids dashboard noise. (Bookmarked
  // general-awareness matches are STILL re-evaluated against OTHER projects
  // via the bookmark-resurface pass — see resurface.ts. The filter here only
  // skips re-discovery, not re-evaluation.)
  if (targets.length > 0) {
    const statusRows = await db
      .select({
        owner: schema.repos.owner,
        name: schema.repos.name,
        status: schema.matches.userStatus,
        integratedAt: schema.matches.integratedAt,
        handoffPrUrl: schema.matches.handoffPrUrl,
      })
      .from(schema.matches)
      .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
      .where(eq(schema.matches.userId, userId));
    const actionedSet = new Set<string>();
    for (const r of statusRows) {
      if (
        r.status === "starred" ||
        r.status === "bookmarked" ||
        r.status === "hidden" ||
        r.integratedAt ||
        r.handoffPrUrl
      ) {
        actionedSet.add(`${r.owner.toLowerCase()}/${r.name.toLowerCase()}`);
      }
    }
    if (actionedSet.size > 0) {
      const before = targets.length;
      for (let i = targets.length - 1; i >= 0; i--) {
        if (actionedSet.has(targets[i].key)) targets.splice(i, 1);
      }
      const skipped = before - targets.length;
      if (skipped > 0) console.log(`[pipeline] skipped ${skipped} already-actioned repos`);
    }
  }

  // Stage 5: trending demotion. Split targets into scouted (has Stage-3
  // outcome attribution) and discovered (everything else — HN, reddit,
  // trending, etc.). Cap the discovered candidate pool pre-LLM so a noisy
  // morning of broad-net fetches doesn't burn the LLM budget; we'll also
  // cap the *match* count post-LLM (see end of runAnalysisInner).
  // See docs/stage-5-scope.md.
  // SERENDIPITY_* env vars are accepted as a back-compat alias for the old
  // names; new deployments should set DISCOVERED_*.
  const DISCOVERED_CANDIDATE_CAP = Number(
    process.env.DISCOVERED_CANDIDATE_CAP ?? process.env.SERENDIPITY_CANDIDATE_CAP ?? 15
  );
  const DISCOVERED_MATCH_CAP = Number(
    process.env.DISCOVERED_MATCH_CAP ?? process.env.SERENDIPITY_MATCH_CAP ?? 3
  );
  if (targets.length > 0 && DISCOVERED_CANDIDATE_CAP >= 0) {
    const scouted: typeof targets = [];
    const discovered: typeof targets = [];
    for (const t of targets) {
      if ((targetedAttribByKey.get(t.key) ?? []).length > 0) scouted.push(t);
      else discovered.push(t);
    }
    // targets is already sorted by weighted score desc, so each sub-array is too.
    const cappedDiscovered = discovered.slice(0, DISCOVERED_CANDIDATE_CAP);
    const dropped = discovered.length - cappedDiscovered.length;
    if (dropped > 0) {
      console.log(`[pipeline] discovered cap dropped ${dropped} candidates (kept ${cappedDiscovered.length} of ${discovered.length})`);
    }
    // Scouted first so worker pool starts with the high-precision pool; the
    // discovered tail is cheaper to abandon mid-run if we hit a quota error.
    targets.length = 0;
    targets.push(...scouted, ...cappedDiscovered);
  }

  let reposAnalyzed = 0;
  let matchesCreated = 0;
  // Set when any worker hits an LlmQuotaError. Other workers see it on their
  // next loop iteration and exit so we don't fire dozens of failing LLM calls.
  let abortReason: LlmQuotaError | null = null;

  // Process targets with a worker-pool. Each target is independent
  // (scanRepo → triage → reasonAboutRepo → match inserts) so they can run
  // concurrently; we cap at REPO_CONCURRENCY to stay under LLM rate limits
  // and avoid hammering the GitHub API. SQLite serialises writes itself.
  const REPO_CONCURRENCY = Number(process.env.ANALYZER_REPO_CONCURRENCY) || 4;

  async function processTarget(t: typeof targets[number]) {
    const label = `${t.owner}/${t.name}`;
    void recordEvent(runId, userId, "scan", `Scanning ${label}`);

    const existing = await db
      .select()
      .from(schema.repos)
      .where(and(eq(schema.repos.owner, t.owner), eq(schema.repos.name, t.name)))
      .get();
    const oneDayAgo = Date.now() - 24 * 3600 * 1000;
    if (existing && existing.lastSeenAt && +existing.lastSeenAt > oneDayAgo) {
      const recentMatch = await db
        .select()
        .from(schema.matches)
        .where(and(eq(schema.matches.repoId, existing.id), eq(schema.matches.userId, userId)))
        .orderBy(desc(schema.matches.createdAt))
        .get();
      if (recentMatch && +recentMatch.createdAt > oneDayAgo) {
        void recordEvent(runId, userId, "skip", `Already analysed today: ${label}`);
        return;
      }
    }

    try {
      const safety = await scanRepo(t.owner, t.name);
      if (!safety) {
        void recordEvent(runId, userId, "skip", `Scan failed: ${label}`);
        return;
      }
      const verdict = shouldSkipBigCo(safety.meta.owner, safety.meta.stars);
      if (verdict.skip) {
        void recordEvent(runId, userId, "skip", `Skipped ${label} — ${verdict.reason}`);
        return;
      }
      reposAnalyzed++;

      const repoRow = await upsertRepo(safety, t);

      await db.insert(schema.safetyScans).values({
        repoId: repoRow.id,
        scannedAt: new Date(),
        postinstallHooks: safety.postinstallHooks.join("\n") || null,
        suspiciousPatterns: safety.suspiciousPatterns.join(", ") || null,
        ageDays: safety.ageDays,
        daysSincePush: safety.daysSincePush,
        contributorCount: safety.contributorCount,
        starVelocity: safety.starVelocity,
        secretsFound: safety.secretsFound,
        riskLevel: safety.riskLevel,
        notes: safety.notes.join("; ") || null,
      });

      const t1 = await triage(safety);
      if (!t1.shouldReason) {
        void recordEvent(runId, userId, "triage_skip", `Triaged ${label} → skip: ${t1.oneLiner}`);
        return;
      }

      // Stage 4 path: when Stage 3 already attributed this repo to specific
      // (project, outcome) pairs, skip the shortlist+writeup pass and run the
      // outcome-attributed scorer instead. One LLM call per unique attribution.
      // Per design lock: don't spillover-score against non-attributed projects.
      const attribs = targetedAttribByKey.get(t.key) ?? [];
      if (attribs.length > 0) {
        // Dedupe by (projectId, outcome) — the same vector firing twice (e.g.
        // matched via multiple query terms) shouldn't double-score.
        const uniqAttribs = new Map<string, AttribWithProjectId>();
        for (const a of attribs) {
          const k = `${a.projectId}:${a.outcome}`;
          if (!uniqAttribs.has(k)) uniqAttribs.set(k, a);
        }
        void recordEvent(runId, userId, "score", `Scoring ${label} against ${uniqAttribs.size} attributed outcome(s)`);

        for (const attr of uniqAttribs.values()) {
          const project = projectsForReasoning.find((p) => projectIdBySlug.get(p.slug) === attr.projectId);
          if (!project) {
            console.warn(`[score-targeted] attribution references missing projectId=${attr.projectId}`);
            continue;
          }
          if (!project.included) {
            console.warn(`[score-targeted] dropping ${label} → ${project.slug}: not included`);
            continue;
          }
          const attribution: TargetedAttribution = {
            outcome: attr.outcome,
            outcomeSource: attr.outcomeSource,
            outcomeConfidence: attr.outcomeConfidence,
            matchedTerm: attr.matchedTerm,
          };
          // STAGE4_VERIFY_WITH_SOURCE=1 enables the BM25 source-context pass:
          // when the cheap README-only score comes back medium/high, clone +
          // index + re-score against retrieved excerpts. Falls back to the
          // baseline verdict on any verification failure, so the worst case
          // matches the unflagged path. Gated for now because the cold-path
          // clone+index cost is non-trivial and the prod data hasn't yet
          // produced the baseline=high false-positive case it's designed to
          // catch — keep it dark until we see that shape live.
          const verifyWithSource = process.env.STAGE4_VERIFY_WITH_SOURCE === "1";
          let ta;
          try {
            ta = verifyWithSource
              ? await scoreWithSourceVerification(safety, project, attribution, {
                  token: readRunOrEnv("githubToken", "GITHUB_TOKEN") ?? null,
                })
              : await scoreTargetedCandidate(safety, project, attribution);
          } catch (e) {
            if (e instanceof LlmQuotaError) throw e;
            console.warn(`[score-targeted] ${label} → ${project.slug} failed`, e);
            continue;
          }
          if (!ta) continue;
          // Drop low-score non-general matches. General-awareness rows are
          // bookmarks — keep them at any score so they can resurface when a
          // future project picks them up.
          if (ta.relevance !== "general-awareness" && (ta.relevanceScore ?? 0) < 50) continue;
          const writeup = renderWriteup(
            { owner: safety.meta.owner, name: safety.meta.name, url: `https://github.com/${safety.meta.owner}/${safety.meta.name}` },
            { oneLiner: "", safetyNotes: "", perProject: [ta] },
            ta,
            safety
          );
          await db.insert(schema.matches).values({
            userId,
            repoId: repoRow.id,
            projectId: attr.projectId,
            runId,
            relevance: ta.relevance,
            relevanceScore: ta.relevanceScore,
            summary: ta.summary,
            whyUseful: ta.whyUseful,
            suggestedUse: ta.suggestedUse,
            integrationApproach: ta.integrationApproach,
            risks: ta.risks,
            writeupMd: writeup,
            userStatus: "unread",
            createdAt: new Date(),
            sourceKind: bestSourceByKey.get(t.key) ?? null,
            matchedOutcome: ta.matchedOutcome,
            matchedOutcomeSource: ta.matchedOutcomeSource,
            matchedOutcomeConfidence: ta.matchedOutcomeConfidence,
            discoveryMode: "scouted",
          });
          matchesCreated++;
          void recordEvent(
            runId,
            userId,
            "match",
            `Match: ${label} → ${project.slug} (${ta.relevance} · ${ta.relevanceScore ?? "—"} · outcome: ${ta.matchedOutcome.slice(0, 50)}…)`
          );
        }
        return; // Don't fall through to reasonAboutRepo — attribution wins.
      }

      void recordEvent(runId, userId, "reason", `Reasoning about ${label} against ${projectsForReasoning.length} projects`);
      const trendingWindows = trendingWindowsByKey.get(t.key);
      const reasoning = await reasonAboutRepo(
        safety,
        projectsForReasoning,
        trendingWindows ? { trendingWindows } : null,
      );

      for (const pa of reasoning.perProject) {
        if ((pa.relevanceScore ?? 0) < 50) continue;
        const project = projectsForReasoning.find((p) => p.slug === pa.projectSlug);
        if (project && !project.included) {
          console.warn(`[analyze] dropping match: project ${project.slug} not included`);
          continue;
        }
        const writeup = renderWriteup(
          { owner: safety.meta.owner, name: safety.meta.name, url: `https://github.com/${safety.meta.owner}/${safety.meta.name}` },
          reasoning,
          pa,
          safety
        );
        const pid = project ? projectIdBySlug.get(project.slug) ?? null : null;
        await db.insert(schema.matches).values({
          userId,
          repoId: repoRow.id,
          projectId: pid,
          runId,
          relevance: pa.relevance,
          relevanceScore: pa.relevanceScore,
          summary: pa.summary,
          whyUseful: pa.whyUseful,
          suggestedUse: pa.suggestedUse,
          integrationApproach: pa.integrationApproach,
          risks: pa.risks,
          writeupMd: writeup,
          userStatus: "unread",
          createdAt: new Date(),
          sourceKind: bestSourceByKey.get(t.key) ?? null,
          discoveryMode: "discovered",
        });
        matchesCreated++;
        const projSlug = project?.slug ?? "_general";
        void recordEvent(
          runId,
          userId,
          "match",
          `Match: ${label} → ${projSlug} (${pa.relevance} · ${pa.relevanceScore ?? "—"})`
        );
      }
    } catch (e) {
      // Quota errors are terminal for the whole run — flag and re-throw so the
      // worker pool stops scheduling new targets. Other errors are per-repo
      // and shouldn't poison the rest of the analysis.
      if (e instanceof LlmQuotaError) {
        abortReason = e;
        throw e;
      }
      console.error(`[analyze] ${t.owner}/${t.name} failed`, e);
      void recordEvent(runId, userId, "error", `Failed: ${t.owner}/${t.name}`);
    }
  }

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(REPO_CONCURRENCY, targets.length); i++) {
    workers.push((async () => {
      while (cursor < targets.length) {
        if (abortReason) return;
        const idx = cursor++;
        try {
          await processTarget(targets[idx]);
        } catch {
          // Quota errors are already captured in abortReason; processTarget's
          // catch handles per-repo errors. Swallow here so allSettled doesn't
          // surface duplicates — we re-throw abortReason after the pool drains.
        }
      }
    })());
  }
  await Promise.allSettled(workers);
  // If any worker hit quota mid-run, surface it now so runPipelineForUser
  // can flag the digest_runs row with pausedReason='llm-quota'.
  if (abortReason) throw abortReason;

  // Bookmark resurface pass: re-evaluate the user's bookmarked GA matches
  // against other projects' outcome goals. Runs AFTER the main worker pool
  // so the skip rules can rely on this run's scouted/discovered inserts
  // already being visible. Per-run cap and 20-day retry are enforced inside.
  // See docs/bookmark-resurface-scope.md.
  try {
    const created = await runResurfacePass(runId, userId, dbProjects);
    matchesCreated += created;
  } catch (e) {
    if (e instanceof LlmQuotaError) throw e;
    console.warn(`[resurface] pass failed for user=${userId}, continuing`, e);
  }

  // Stage 5: post-pass match cap. Trim surplus discovered rows from THIS run
  // so the digest stays dense. Only touches discovery_mode='discovered' from
  // the current runId — scouted and re-checked rows are preserved at any
  // count. We keep the top DISCOVERED_MATCH_CAP by relevanceScore.
  if (DISCOVERED_MATCH_CAP >= 0) {
    const discoveredRows = await db
      .select({ id: schema.matches.id, score: schema.matches.relevanceScore })
      .from(schema.matches)
      .where(and(
        eq(schema.matches.userId, userId),
        eq(schema.matches.runId, runId),
        eq(schema.matches.discoveryMode, "discovered"),
      ))
      .orderBy(desc(schema.matches.relevanceScore));
    if (discoveredRows.length > DISCOVERED_MATCH_CAP) {
      const toDelete = discoveredRows.slice(DISCOVERED_MATCH_CAP).map((r) => r.id);
      for (const id of toDelete) {
        await db.delete(schema.matches).where(eq(schema.matches.id, id));
      }
      const removed = toDelete.length;
      matchesCreated -= removed;
      console.log(`[pipeline] discovered match cap pruned ${removed} (kept top ${DISCOVERED_MATCH_CAP})`);
      void recordEvent(runId, userId, "skip", `Trimmed ${removed} discovered matches over cap of ${DISCOVERED_MATCH_CAP}`);
    }
  }

  return { reposAnalyzed, matchesCreated };
}

async function upsertRepo(safety: SafetyReport, t: { owner: string; name: string }) {
  const now = new Date();
  const existing = await db
    .select()
    .from(schema.repos)
    .where(and(eq(schema.repos.owner, t.owner), eq(schema.repos.name, t.name)))
    .get();
  if (existing) {
    await db
      .update(schema.repos)
      .set({
        description: safety.meta.description,
        stars: safety.meta.stars,
        forks: safety.meta.forks,
        license: safety.meta.license,
        primaryLanguage: safety.meta.language,
        pushedAt: safety.meta.pushedAt ? new Date(safety.meta.pushedAt) : null,
        createdAt: safety.meta.createdAt ? new Date(safety.meta.createdAt) : null,
        defaultBranch: safety.meta.defaultBranch,
        readmeMd: safety.readmeMd,
        readmeSha: safety.readmeSha,
        lastSeenAt: now,
      })
      .where(eq(schema.repos.id, existing.id));
    return existing;
  }
  const ins = await db
    .insert(schema.repos)
    .values({
      owner: t.owner,
      name: t.name,
      url: `https://github.com/${t.owner}/${t.name}`,
      description: safety.meta.description,
      stars: safety.meta.stars,
      forks: safety.meta.forks,
      license: safety.meta.license,
      primaryLanguage: safety.meta.language,
      pushedAt: safety.meta.pushedAt ? new Date(safety.meta.pushedAt) : null,
      createdAt: safety.meta.createdAt ? new Date(safety.meta.createdAt) : null,
      defaultBranch: safety.meta.defaultBranch,
      readmeMd: safety.readmeMd,
      readmeSha: safety.readmeSha,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .returning()
    .get();
  return ins!;
}

const RESURFACE_RETRY_DAYS = 20;

type DbProject = typeof schema.projectProfiles.$inferSelect;

// Bookmark resurface: re-score the user's bookmarked general-awareness matches
// against the outcome goals of OTHER projects (i.e. projects the bookmark
// didn't originally surface for). The motivation is in
// docs/active-scouting-plan.md § "Stage 4 input: starred general-awareness as
// bookmarks-for-later" and the design is locked in
// docs/bookmark-resurface-scope.md.
//
// Per (bookmark, project) pair, eligibility is:
//   - bookmark.userStatus = 'bookmarked' (the migration backfills these)
//   - bookmark.relevance = 'general-awareness' (sanity check)
//   - bookmark.archivedAt is null
//   - bookmark.createdAt is older than 24h (don't resurface today's saves)
//   - project.included is true
//   - project has summaryJson + searchVectorsJson (Stage 1+2 complete)
//   - project.id != bookmark.projectId (don't resurface to origin project)
//   - no successful match exists for (userId, repoId, projectId)
//   - no resurface_attempts row within RESURFACE_RETRY_DAYS for the pair
//
// Capped at RESURFACE_PER_RUN_CAP per run; resurface inserts are tagged
// discoveryMode='bookmark' and link back to the original via
// resurfacedFromMatchId.
async function runResurfacePass(
  runId: number,
  userId: number,
  dbProjects: DbProject[],
): Promise<number> {
  if (process.env.RESURFACE_ENABLED === "0") return 0;
  const PER_RUN_CAP = Number(process.env.RESURFACE_PER_RUN_CAP ?? 30);
  if (PER_RUN_CAP <= 0) return 0;

  // Eligible projects: included + Stage 1+2 complete. Anything else can't be
  // resurface-targeted because we have no outcomes to match against.
  const eligibleProjects = dbProjects.filter(
    (p) => p.included && p.summaryJson && p.searchVectorsJson,
  );
  if (eligibleProjects.length === 0) {
    console.log(`[resurface] user=${userId} skip: no eligible projects (need Stage 1+2 complete)`);
    return 0;
  }

  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const bookmarks = await db
    .select()
    .from(schema.matches)
    .where(and(
      eq(schema.matches.userId, userId),
      eq(schema.matches.userStatus, "bookmarked"),
      eq(schema.matches.relevance, "general-awareness"),
      isNull(schema.matches.archivedAt),
    ))
    .orderBy(desc(schema.matches.createdAt));
  if (bookmarks.length === 0) return 0;

  const aged = bookmarks.filter((b) => +b.createdAt < +dayAgo);
  if (aged.length === 0) {
    console.log(`[resurface] user=${userId} skip: ${bookmarks.length} bookmarks all <24h old`);
    return 0;
  }

  // Existing matches for this user — used to skip (repoId, projectId) pairs
  // that already have any match row (resurface or otherwise).
  const existingMatches = await db
    .select({ repoId: schema.matches.repoId, projectId: schema.matches.projectId })
    .from(schema.matches)
    .where(eq(schema.matches.userId, userId));
  const matchedPairs = new Set<string>();
  for (const r of existingMatches) {
    if (r.projectId !== null) matchedPairs.add(`${r.repoId}:${r.projectId}`);
  }

  // Recent resurface attempts — honour the 20-day retry window.
  const retryCutoff = new Date(Date.now() - RESURFACE_RETRY_DAYS * 24 * 3600 * 1000);
  const recentAttempts = await db
    .select({
      repoId: schema.resurfaceAttempts.repoId,
      projectId: schema.resurfaceAttempts.projectId,
    })
    .from(schema.resurfaceAttempts)
    .where(and(
      eq(schema.resurfaceAttempts.userId, userId),
      gte(schema.resurfaceAttempts.attemptedAt, retryCutoff),
    ));
  const recentlyAttempted = new Set<string>();
  for (const a of recentAttempts) recentlyAttempted.add(`${a.repoId}:${a.projectId}`);

  // Build the eligible (bookmark, project) candidate list.
  type Candidate = {
    bookmark: typeof bookmarks[number];
    project: DbProject;
    summary: ProjectSummary;
  };
  const candidates: Candidate[] = [];
  for (const b of aged) {
    for (const p of eligibleProjects) {
      if (p.id === b.projectId) continue; // skip origin project
      const key = `${b.repoId}:${p.id}`;
      if (matchedPairs.has(key)) continue;
      if (recentlyAttempted.has(key)) continue;
      let summary: ProjectSummary;
      try {
        summary = JSON.parse(p.summaryJson ?? "{}") as ProjectSummary;
      } catch {
        continue;
      }
      if (!Array.isArray(summary.outcomeGoals) || summary.outcomeGoals.length === 0) continue;
      candidates.push({ bookmark: b, project: p, summary });
      if (candidates.length >= PER_RUN_CAP) break;
    }
    if (candidates.length >= PER_RUN_CAP) break;
  }

  if (candidates.length === 0) {
    console.log(`[resurface] user=${userId} no eligible (bookmark, project) pairs after filtering`);
    return 0;
  }

  console.log(`[resurface] user=${userId} processing ${candidates.length} pair(s) (cap=${PER_RUN_CAP})`);
  void recordEvent(runId, userId, "scan", `Resurface: evaluating ${candidates.length} bookmark(s) against your projects`);

  // Repo scan cache — same repo may appear in multiple pairs.
  const scanByRepoId = new Map<number, SafetyReport>();
  const repoRowById = new Map<number, typeof schema.repos.$inferSelect>();
  let created = 0;

  for (const c of candidates) {
    const { bookmark, project, summary } = c;
    let repoRow = repoRowById.get(bookmark.repoId);
    if (!repoRow) {
      const r = await db.select().from(schema.repos).where(eq(schema.repos.id, bookmark.repoId)).get();
      if (!r) continue;
      repoRow = r;
      repoRowById.set(bookmark.repoId, r);
    }
    let safety = scanByRepoId.get(bookmark.repoId);
    if (!safety) {
      const s = await scanRepo(repoRow.owner, repoRow.name);
      if (!s) {
        console.warn(`[resurface] scan failed for ${repoRow.owner}/${repoRow.name}; skipping bookmark`);
        continue;
      }
      safety = s;
      scanByRepoId.set(bookmark.repoId, s);
    }

    const localProject: LocalProject = {
      slug: project.slug,
      path: project.path,
      name: project.name,
      readmeMd: project.readmeMd,
      claudeMd: project.claudeMd,
      techSummary: project.techSummary,
      profileHash: project.profileHash,
      active: !!project.active,
      included: !!project.included,
      sensitivity: (project.sensitivity as "low" | "high") ?? "low",
      llmProvider: (project.llmProvider as "auto" | "deepseek" | "anthropic") ?? "auto",
    };

    let result;
    try {
      result = await scoreBookmarkAgainstProject({
        safety,
        project: localProject,
        outcomes: summary.outcomeGoals,
        bookmarkedAt: bookmark.createdAt,
      });
    } catch (e) {
      if (e instanceof LlmQuotaError) throw e;
      console.warn(`[resurface] scoring failed ${repoRow.owner}/${repoRow.name} → ${project.slug}`, e);
      continue;
    }
    if (result.kind === "error") continue;

    // Always record the attempt so the 20-day retry window applies — both
    // matches and no-fits get a tombstone.
    await db.insert(schema.resurfaceAttempts).values({
      userId,
      repoId: bookmark.repoId,
      projectId: project.id,
      attemptedAt: new Date(),
      outcome: result.kind === "match" ? "matched" : "no-fit",
    }).onConflictDoUpdate({
      target: [
        schema.resurfaceAttempts.userId,
        schema.resurfaceAttempts.repoId,
        schema.resurfaceAttempts.projectId,
      ],
      set: {
        attemptedAt: new Date(),
        outcome: result.kind === "match" ? "matched" : "no-fit",
      },
    });

    if (result.kind !== "match") {
      void recordEvent(runId, userId, "triage_skip", `Resurface: ${repoRow.owner}/${repoRow.name} → ${project.slug} no fit`);
      continue;
    }

    // Floor: don't insert resurface matches below 50. Bookmarks that score
    // medium-but-weak should wait until a stronger fit emerges.
    if ((result.assessment.relevanceScore ?? 0) < 50) {
      void recordEvent(runId, userId, "triage_skip", `Resurface: ${repoRow.owner}/${repoRow.name} → ${project.slug} below score floor`);
      continue;
    }

    const writeup = renderWriteup(
      { owner: repoRow.owner, name: repoRow.name, url: repoRow.url },
      { oneLiner: "", safetyNotes: "", perProject: [result.assessment] },
      result.assessment,
      safety
    );
    await db.insert(schema.matches).values({
      userId,
      repoId: bookmark.repoId,
      projectId: project.id,
      runId,
      relevance: result.assessment.relevance,
      relevanceScore: result.assessment.relevanceScore,
      summary: result.assessment.summary,
      whyUseful: result.assessment.whyUseful,
      suggestedUse: result.assessment.suggestedUse,
      integrationApproach: result.assessment.integrationApproach,
      risks: result.assessment.risks,
      writeupMd: writeup,
      userStatus: "unread",
      createdAt: new Date(),
      sourceKind: bookmark.sourceKind, // carry forward the original discovery source for analytics
      matchedOutcome: result.assessment.matchedOutcome,
      matchedOutcomeSource: result.assessment.matchedOutcomeSource,
      matchedOutcomeConfidence: result.assessment.matchedOutcomeConfidence,
      discoveryMode: "re-checked",
      resurfacedFromMatchId: bookmark.id,
    });
    created++;
    void recordEvent(
      runId,
      userId,
      "match",
      `Resurface match: ${repoRow.owner}/${repoRow.name} → ${project.slug} (${result.assessment.relevance} · ${result.assessment.relevanceScore})`,
    );
  }

  console.log(`[resurface] user=${userId} inserted ${created} resurface match(es) from ${candidates.length} pair(s)`);
  return created;
}

