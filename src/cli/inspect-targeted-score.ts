// One-shot: run Stage-4 (score-targeted) on the gh-targeted candidates a
// user has in the candidates table. Pure observation — does not insert into
// matches. Useful for validating prompt + relevance threshold before letting
// the pipeline persist real rows.
//
// Usage:
//   tsx src/cli/inspect-targeted-score.ts --user=1 --slug=acme-web
//   tsx src/cli/inspect-targeted-score.ts --user=1 --slug=acme-web --limit=3
//   tsx src/cli/inspect-targeted-score.ts --user=1 --slug=acme-web --outcome=explainable
//      (case-insensitive substring match against vector.outcome)
//
// Scans recent gh-targeted candidates attributed to <slug>, deduplicates by
// (projectId, outcome) and (owner/name), runs scoreTargetedCandidate against
// each, and prints the per-match assessment.

import { db, schema } from "../db/client";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { scanRepo } from "../scanner/safety";
import { scoreTargetedCandidate } from "../analyzer/score-targeted";
import { resolveUserConfig } from "../scheduler/user-config";
import { withRunConfig } from "../analyzer/run-context";
import type { LocalProject } from "../projects/loader";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const userIdStr = arg("user");
  const slug = arg("slug");
  const limit = parseInt(arg("limit") ?? "5", 10);
  const outcomeFilter = arg("outcome")?.toLowerCase() ?? null;
  if (!userIdStr || !slug) {
    console.error(`Usage: tsx src/cli/inspect-targeted-score.ts --user=<id> --slug=<project-slug> [--limit=<N>]`);
    process.exit(1);
  }
  const userId = parseInt(userIdStr, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error(`Invalid --user=${userIdStr}`);
    process.exit(1);
  }

  const projectRow = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.slug, slug)))
    .get();
  if (!projectRow) {
    console.error(`Project ${slug} not found for user=${userId}`);
    process.exit(1);
  }
  const project: LocalProject = {
    slug: projectRow.slug,
    path: projectRow.path,
    name: projectRow.name,
    readmeMd: projectRow.readmeMd,
    claudeMd: projectRow.claudeMd,
    techSummary: projectRow.techSummary,
    profileHash: projectRow.profileHash,
    active: !!projectRow.active,
    included: !!projectRow.included,
    sensitivity: (projectRow.sensitivity as "low" | "high") ?? "low",
    llmProvider: (projectRow.llmProvider as "auto" | "deepseek" | "anthropic") ?? "auto",
  };

  // Recent gh-targeted candidates for this project (last 48h).
  const since = new Date(Date.now() - 48 * 3600 * 1000);
  const cands = await db
    .select()
    .from(schema.candidates)
    .where(
      and(
        eq(schema.candidates.userId, userId),
        gte(schema.candidates.fetchedAt, since),
        like(schema.candidates.source, `gh-targeted:${slug}`),
      ),
    )
    .orderBy(desc(schema.candidates.fetchedAt));

  if (cands.length === 0) {
    console.error(`No gh-targeted candidates found for user=${userId} slug=${slug} in last 48h. Run inspect-targeted-search first.`);
    process.exit(1);
  }
  console.error(`[inspect-score] found ${cands.length} gh-targeted candidates for ${slug}; scoring top ${limit}`);

  const cfg = await resolveUserConfig(userId);
  await withRunConfig(
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
    async () => {
      let scored = 0;
      for (const c of cands) {
        if (scored >= limit) break;
        if (!c.rawJson) continue;
        let raw: {
          owner?: string;
          name?: string;
          outcome?: string;
          outcomeSource?: string;
          outcomeConfidence?: string;
          matchedTerm?: string;
        };
        try {
          raw = JSON.parse(c.rawJson);
        } catch {
          continue;
        }
        if (!raw.owner || !raw.name || !raw.outcome) continue;
        if (raw.outcomeSource !== "user" && raw.outcomeSource !== "inferred") continue;
        if (raw.outcomeConfidence !== "high" && raw.outcomeConfidence !== "medium") continue;
        if (outcomeFilter && !raw.outcome.toLowerCase().includes(outcomeFilter)) continue;

        console.log(`\n--- ${raw.owner}/${raw.name}`);
        console.log(`    outcome: ${raw.outcome}`);
        console.log(`    matched: "${raw.matchedTerm ?? "?"}"`);
        const safety = await scanRepo(raw.owner, raw.name);
        if (!safety) {
          console.log(`    [skip] scan failed`);
          continue;
        }
        const ta = await scoreTargetedCandidate(safety, project, {
          outcome: raw.outcome,
          outcomeSource: raw.outcomeSource,
          outcomeConfidence: raw.outcomeConfidence,
          matchedTerm: raw.matchedTerm ?? "",
        });
        if (!ta) {
          console.log(`    [drop] scorer returned null`);
          continue;
        }
        scored++;
        console.log(`    → ${ta.relevance} (${ta.relevanceScore})`);
        console.log(`    summary: ${ta.summary}`);
        console.log(`    whyUseful: ${ta.whyUseful}`);
        console.log(`    suggestedUse: ${ta.suggestedUse}`);
      }
      console.error(`\n[inspect-score] scored ${scored} candidates`);
    },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
