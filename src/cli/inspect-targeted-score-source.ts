// A/B: run Stage-4 (scoreTargetedCandidate) twice against the same candidate,
// once WITHOUT source excerpts (baseline) and once WITH BM25-retrieved source
// excerpts. Prints both verdicts side-by-side so we can see whether the
// indexer actually changes the LLM's judgement on real cases.
//
// This is the validation step for the indexer wire-in. The hypothesis is that
// repos with stub READMEs (e.g. Firebase Studio placeholders) should drop from
// medium/high to general-awareness once the LLM can see the empty source tree;
// repos with rich on-point source under a sparse README should rise.
//
// Self-contained: the project context is read from a local directory (README.md
// + CLAUDE.md), the LLM keys come from process.env. No DB user lookup, no
// projectProfiles row needed. Anyone can validate against any local project.
//
// Usage:
//   tsx src/cli/inspect-targeted-score-source.ts \
//     --project-path=. --project-name=replen --project-slug=replen \
//     --owner=agentace --repo=microsandbox \
//     --outcome="sandboxed code execution for agent workflows"
//
// Optional:
//   --matched-term=<term>   (defaults to the outcome)
//   --source=user|inferred  (defaults to user)
//   --confidence=high|medium (defaults to high)
//   --tech="<short tech summary string>"

import { readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { scanRepo } from "../scanner/safety";
import { scoreTargetedCandidate } from "../analyzer/score-targeted";
import { withRunConfig } from "../analyzer/run-context";
import { shallowClone } from "../lib/repo-index/clone";
import { ensureRepoIndex, retrieveSourceExcerpts } from "../analyzer/source-context";
import type { LocalProject } from "../projects/loader";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function tryRead(p: string): Promise<string | null> {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

async function loadProjectFromPath(path: string, slug: string, name: string, tech: string | null): Promise<LocalProject> {
  // Try the common README casings; first hit wins. Mirrors loader.ts's
  // DOC_NAMES list approximately — we don't need its full machinery here.
  const readme =
    (await tryRead(join(path, "README.md"))) ??
    (await tryRead(join(path, "Readme.md"))) ??
    (await tryRead(join(path, "readme.md")));
  const claudeMd =
    (await tryRead(join(path, "CLAUDE.md"))) ??
    (await tryRead(join(path, "Claude.md"))) ??
    (await tryRead(join(path, "claude.md")));
  return {
    slug,
    path,
    name,
    readmeMd: readme,
    claudeMd,
    techSummary: tech,
    profileHash: "inspector",
    active: true,
    included: true,
    sensitivity: "low",
    llmProvider: "auto",
  };
}

async function getOrCreateRepoId(owner: string, name: string): Promise<number> {
  const existing = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name)))
    .get();
  if (existing) return existing.id;
  const now = new Date();
  const ins = await db
    .insert(schema.repos)
    .values({
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .returning({ id: schema.repos.id })
    .get();
  if (!ins) throw new Error("failed to insert repos row");
  return ins.id;
}

async function main() {
  const projectPath = arg("project-path");
  const projectSlug = arg("project-slug");
  const projectName = arg("project-name");
  const owner = arg("owner");
  const repo = arg("repo");
  const outcome = arg("outcome");
  const matchedTerm = arg("matched-term") ?? outcome;
  const sourceMode = (arg("source") ?? "user") as "user" | "inferred";
  const confidence = (arg("confidence") ?? "high") as "high" | "medium";
  const tech = arg("tech") ?? null;

  if (!projectPath || !owner || !repo || !outcome) {
    console.error(
      `Usage: tsx src/cli/inspect-targeted-score-source.ts --project-path=<dir> --owner=<gh-owner> --repo=<gh-repo> --outcome="<outcome>"\n  [--project-slug=<slug>] [--project-name=<name>] [--tech="<tech>"] [--matched-term=<term>] [--source=user|inferred] [--confidence=high|medium]`,
    );
    process.exit(1);
  }
  const absProjectPath = resolve(projectPath);
  const slug = projectSlug ?? basename(absProjectPath);
  const name = projectName ?? slug;
  const project = await loadProjectFromPath(absProjectPath, slug, name, tech);

  if (!project.readmeMd) {
    console.error(`No README found under ${absProjectPath} — Stage 4 won't have project context to compare against`);
  }

  // Build RunConfig from env. The inspector intentionally relies on env-only
  // credentials — no per-user secrets, since there's no DB user.
  const runCfg = {
    llmPrimaryApiKey: process.env.DEEPSEEK_API_KEY ?? undefined,
    llmPrimaryBaseUrl: process.env.DEEPSEEK_BASE_URL ?? undefined,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? undefined,
    githubToken: process.env.GITHUB_TOKEN ?? undefined,
  };

  await withRunConfig(runCfg, async () => {
    const safety = await scanRepo(owner, repo);
    if (!safety) {
      console.error(`Safety scan failed for ${owner}/${repo}`);
      process.exit(1);
    }

    console.log(`\n=== ${owner}/${repo} → ${project.slug} ===`);
    console.log(`outcome: "${outcome}"`);
    console.log(`README bytes: ${safety.readmeMd.length}`);

    const attribution = {
      outcome,
      outcomeSource: sourceMode,
      outcomeConfidence: confidence,
      matchedTerm: matchedTerm ?? outcome,
    };

    // BASELINE: no source excerpts.
    console.error(`\n[baseline] scoring without source excerpts…`);
    const t0 = Date.now();
    const baseline = await scoreTargetedCandidate(safety, project, attribution);
    const baselineMs = Date.now() - t0;

    // WITH SOURCE: clone, build index, retrieve excerpts, score.
    console.error(`[with-source] cloning ${owner}/${repo}…`);
    const cloneStart = Date.now();
    const cloned = await shallowClone(owner, repo, { token: runCfg.githubToken });
    const cloneMs = Date.now() - cloneStart;
    let scoredWith: typeof baseline = null;
    let excerptCount = 0;
    let queries: string[] = [];
    let indexMs = 0;
    let retrieveMs = 0;
    let scoreMs = 0;
    try {
      const repoId = await getOrCreateRepoId(owner, repo);
      console.error(`[with-source] indexing (repoId=${repoId})…`);
      const tIdx = Date.now();
      const indexId = await ensureRepoIndex(repoId, resolve(cloned.path), {
        readmeSha: safety.readmeSha,
      });
      indexMs = Date.now() - tIdx;
      const tRet = Date.now();
      const { excerpts, queries: q } = await retrieveSourceExcerpts(
        indexId,
        { outcome, matchedTerm: matchedTerm ?? outcome },
        project.techSummary,
      );
      retrieveMs = Date.now() - tRet;
      excerptCount = excerpts.length;
      queries = q;
      console.error(`[with-source] scoring with ${excerptCount} excerpts…`);
      const tScore = Date.now();
      scoredWith = await scoreTargetedCandidate(safety, project, attribution, {
        sourceExcerpts: excerpts,
      });
      scoreMs = Date.now() - tScore;
    } finally {
      await cloned.cleanup();
    }

    console.log(`\n--- timings`);
    console.log(`  baseline score:    ${baselineMs}ms`);
    console.log(`  clone:             ${cloneMs}ms`);
    console.log(`  index build:       ${indexMs}ms`);
    console.log(`  retrieve excerpts: ${retrieveMs}ms (${excerptCount} excerpts)`);
    console.log(`  with-source score: ${scoreMs}ms`);
    console.log(`  queries: ${queries.map((q) => `"${q.slice(0, 40)}"`).join(", ")}`);

    const printVerdict = (label: string, v: typeof baseline) => {
      console.log(`\n--- ${label}`);
      if (!v) {
        console.log(`  (scorer returned null)`);
        return;
      }
      console.log(`  relevance:      ${v.relevance} (${v.relevanceScore})`);
      console.log(`  summary:        ${v.summary}`);
      console.log(`  whyUseful:      ${v.whyUseful}`);
      console.log(`  suggestedUse:   ${v.suggestedUse}`);
      console.log(`  integration:    ${v.integrationApproach}`);
      console.log(`  risks:          ${v.risks}`);
    };
    printVerdict("BASELINE (no source)", baseline);
    printVerdict("WITH SOURCE", scoredWith);

    // Headline diff
    console.log(`\n--- diff`);
    const a = baseline ? `${baseline.relevance}/${baseline.relevanceScore}` : "null";
    const b = scoredWith ? `${scoredWith.relevance}/${scoredWith.relevanceScore}` : "null";
    console.log(`  ${a}  →  ${b}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
