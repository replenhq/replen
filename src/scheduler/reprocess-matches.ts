// Re-runs the deep reasoning pass over existing matches and updates their writeup_md
// in place. Use this after a prompt change or after the user flipped a project's
// llm_provider / sensitivity (so writeups regenerate against the new model).
//
// Two modes:
//   - default: filters to matches whose writeup looks old (## headers, missing prose markers)
//   - forceAll: reprocess everything matching, regardless of writeup format
//
// Optional projectSlug narrows the work to a single project.
//
// Run as CLI:
//   set -a; . ./.env; set +a; npx tsx src/scheduler/reprocess-matches.ts [user_id]
//   FORCE_ALL=1 PROJECT_SLUG=ledgerai npx tsx src/scheduler/reprocess-matches.ts 1

import { db, schema } from "../db/client";
import { and, desc, eq, inArray } from "drizzle-orm";
import { reasonAboutRepo, renderWriteup, type ProjectAssessment } from "../analyzer/reason";
import { resolveUserConfig } from "./user-config";
import type { LocalProject } from "../projects/loader";
import type { SafetyReport } from "../scanner/safety";

const DEFAULT_LIMIT = parseInt(process.env.REPROCESS_LIMIT ?? "25", 10);
const DELETE_REJECTED = process.env.DELETE_REJECTED === "1";

export type ReprocessOpts = {
  projectSlug?: string;
  forceAll?: boolean;
  limit?: number;
};

function looksOldFormat(writeupMd: string | null): boolean {
  if (!writeupMd) return true;
  if (/^#{2,6}\s/m.test(writeupMd)) return true;
  if (writeupMd.includes("**One-liner:**") || writeupMd.includes("**Relevance to")) return true;
  if (!writeupMd.includes("concrete plug points where it earns its place")) return true;
  return false;
}

function buildSafetyReport(
  repo: typeof schema.repos.$inferSelect,
  scan: typeof schema.safetyScans.$inferSelect
): SafetyReport {
  return {
    meta: {
      owner: repo.owner,
      name: repo.name,
      description: repo.description,
      stars: repo.stars ?? 0,
      forks: repo.forks ?? 0,
      pushedAt: repo.pushedAt?.toISOString() ?? null,
      createdAt: repo.createdAt?.toISOString() ?? null,
      defaultBranch: repo.defaultBranch ?? "main",
      language: repo.primaryLanguage,
      license: repo.license,
      archived: false,
      disabled: false,
    },
    readmeMd: repo.readmeMd ?? "",
    readmeSha: repo.readmeSha ?? "",
    ageDays: scan.ageDays ?? 0,
    daysSincePush: scan.daysSincePush ?? 0,
    contributorCount: scan.contributorCount ?? 0,
    starVelocity: scan.starVelocity ?? 0,
    postinstallHooks: scan.postinstallHooks?.split("\n").filter(Boolean) ?? [],
    suspiciousPatterns: scan.suspiciousPatterns?.split(", ").filter(Boolean) ?? [],
    secretsFound: !!scan.secretsFound,
    riskLevel: (scan.riskLevel as any) ?? "low",
    notes: scan.notes?.split("; ").filter(Boolean) ?? [],
  };
}

export async function reprocessForUser(userId: number, opts: ReprocessOpts = {}): Promise<{ fixed: number; skipped: number }> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  console.log(`[reprocess] user=${userId} starting (projectSlug=${opts.projectSlug ?? "*"} forceAll=${!!opts.forceAll} limit=${limit})`);
  const cfg = await resolveUserConfig(userId);
  const prev = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  if (cfg.deepseekApiKey) process.env.DEEPSEEK_API_KEY = cfg.deepseekApiKey;
  if (cfg.anthropicApiKey) process.env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;

  let fixed = 0, skipped = 0;
  try {
    const dbProjects = await db
      .select()
      .from(schema.projectProfiles)
      .where(eq(schema.projectProfiles.userId, userId));
    const projects: LocalProject[] = dbProjects.map((p) => ({
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
    const slugByProjectId = new Map(dbProjects.map((p) => [p.id, p.slug]));

    let matches = await db
      .select()
      .from(schema.matches)
      .where(eq(schema.matches.userId, userId))
      .orderBy(desc(schema.matches.relevanceScore));

    if (opts.projectSlug) {
      const target = opts.projectSlug === "_general" ? null : projectIdBySlug.get(opts.projectSlug);
      matches = matches.filter((m) => m.projectId === target);
    }
    const toFix = (opts.forceAll ? matches : matches.filter((m) => looksOldFormat(m.writeupMd))).slice(0, limit);
    console.log(`[reprocess] user=${userId} ${matches.length} candidate matches, ${toFix.length} will be processed`);

    for (const m of toFix) {
      try {
        const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, m.repoId)).get();
        if (!repo) { skipped++; continue; }
        const scan = await db
          .select()
          .from(schema.safetyScans)
          .where(eq(schema.safetyScans.repoId, repo.id))
          .orderBy(desc(schema.safetyScans.scannedAt))
          .get();
        if (!scan) { skipped++; continue; }

        const safety = buildSafetyReport(repo, scan);
        const reasoning = await reasonAboutRepo(safety, projects);
        const targetSlug = m.projectId ? slugByProjectId.get(m.projectId) ?? "_general" : "_general";
        const pa: ProjectAssessment | undefined = reasoning.perProject.find((x) => x.projectSlug === targetSlug);
        if (!pa || (pa.relevanceScore ?? 0) < 50) {
          if (DELETE_REJECTED) {
            await db.delete(schema.matches).where(eq(schema.matches.id, m.id));
            console.log(`  [delete] ${repo.owner}/${repo.name} → ${targetSlug}`);
          } else {
            console.log(`  [skip] ${repo.owner}/${repo.name} → ${targetSlug}`);
          }
          skipped++;
          continue;
        }
        const writeup = renderWriteup(
          { owner: safety.meta.owner, name: safety.meta.name, url: `https://github.com/${safety.meta.owner}/${safety.meta.name}` },
          reasoning,
          pa,
          safety
        );
        await db
          .update(schema.matches)
          .set({
            relevance: pa.relevance,
            relevanceScore: pa.relevanceScore,
            summary: pa.summary,
            whyUseful: pa.whyUseful,
            suggestedUse: pa.suggestedUse,
            integrationApproach: pa.integrationApproach,
            risks: pa.risks,
            writeupMd: writeup,
          })
          .where(eq(schema.matches.id, m.id));
        fixed++;
        console.log(`  [ok] ${repo.owner}/${repo.name} → ${targetSlug} (${pa.relevance} ${pa.relevanceScore})`);
      } catch (e) {
        console.error(`  [fail] match ${m.id}:`, (e as any)?.message ?? e);
        skipped++;
      }
    }
    console.log(`[reprocess] user=${userId} done: fixed=${fixed} skipped=${skipped}`);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { fixed, skipped };
}

// CLI entry — only runs when invoked directly, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cliUserId = process.argv[2] ? Number(process.argv[2]) : null;
  const opts: ReprocessOpts = {
    projectSlug: process.env.PROJECT_SLUG || undefined,
    forceAll: process.env.FORCE_ALL === "1",
  };
  if (cliUserId !== null && Number.isFinite(cliUserId)) {
    await reprocessForUser(cliUserId, opts);
  } else {
    const users = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.status, "active"));
    for (const u of users) {
      await reprocessForUser(u.id, opts);
    }
  }
  process.exit(0);
}

void inArray;
void and;
