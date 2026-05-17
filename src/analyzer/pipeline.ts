import { db, schema } from "../db/client";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { scanRepo, type SafetyReport } from "../scanner/safety";
import { triage } from "./triage";
import { reasonAboutRepo, renderWriteup } from "./reason";
import { discoverLocalProjects, upsertProjects, type LocalProject } from "../projects/loader";
import { shouldSkip as shouldSkipBigCo } from "../fetchers/big-co";
import { getSourceQualityWeights, sourceKind as sourceKindOf, sourceRank } from "../lib/source-rank";
import type { UserConfig } from "../scheduler/user-config";
import { withRunConfig } from "./run-context";
import { recordEvent } from "../scheduler/events";

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
  const targets: { owner: string; name: string; key: string }[] = [];
  for (const c of cands) {
    const m = c.githubUrl?.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
    if (!m) continue;
    const key = `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
    const kind = sourceKindOf(c.source);
    const prev = bestSourceByKey.get(key);
    if (!prev || sourceRank(kind) < sourceRank(prev)) bestSourceByKey.set(key, kind);
    // Weight candidate score by source feedback quality (default 1.0).
    const baseScore = c.score ?? 0;
    const weighted = baseScore * (weights.get(kind) ?? 1.0);
    const prevScore = scoreByKey.get(key) ?? -Infinity;
    if (weighted > prevScore) scoreByKey.set(key, weighted);
    if (!targets.find((x) => x.key === key)) {
      targets.push({ owner: m[1], name: m[2].replace(/\.git$/, ""), key });
    }
  }
  // Reorder targets by their best weighted score, descending.
  targets.sort((a, b) => (scoreByKey.get(b.key) ?? 0) - (scoreByKey.get(a.key) ?? 0));

  // Skip-actioned filter: if the user has already starred, hidden, integrated,
  // or opened a handoff PR for a repo, don't re-analyse it. Saves LLM cost and
  // avoids dashboard noise.
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
      if (r.status === "starred" || r.status === "hidden" || r.integratedAt || r.handoffPrUrl) {
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

  let reposAnalyzed = 0;
  let matchesCreated = 0;

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

      void recordEvent(runId, userId, "reason", `Reasoning about ${label} against ${projectsForReasoning.length} projects`);
      const reasoning = await reasonAboutRepo(safety, projectsForReasoning);

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
      console.error(`[analyze] ${t.owner}/${t.name} failed`, e);
      void recordEvent(runId, userId, "error", `Failed: ${t.owner}/${t.name}`);
    }
  }

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(REPO_CONCURRENCY, targets.length); i++) {
    workers.push((async () => {
      while (cursor < targets.length) {
        const idx = cursor++;
        await processTarget(targets[idx]);
      }
    })());
  }
  await Promise.all(workers);

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

