// One-shot: generate Stage-2 ProjectSearchVectors for a single project and
// print as JSON. Used to manually validate the prompt produces useful query
// vectors before wiring into pipeline runs. Mirrors inspect-project-summary.
//
// Usage:
//   tsx src/cli/inspect-search-vectors.ts --user=1 --slug=acme-web
//   tsx src/cli/inspect-search-vectors.ts --user=1 --slug=acme-web --persist

import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { generateSearchVectors, vectorsNeedRegeneration, VECTORS_PROMPT_VERSION } from "../projects/search-vectors";
import type { ProjectSummary } from "../projects/summarize";
import { resolveUserConfig } from "../scheduler/user-config";
import { withRunConfig } from "../analyzer/run-context";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const userIdStr = arg("user");
  const slug = arg("slug");
  const persist = flag("persist");
  if (!userIdStr || !slug) {
    console.error(`Usage: tsx src/cli/inspect-search-vectors.ts --user=<id> --slug=<project-slug> [--persist]`);
    process.exit(1);
  }
  const userId = parseInt(userIdStr, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error(`Invalid --user=${userIdStr}`);
    process.exit(1);
  }

  const project = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.slug, slug)))
    .get();
  if (!project) {
    console.error(`No project found for user=${userId} slug=${slug}`);
    process.exit(1);
  }

  // Vectors require a Stage-1 summary. If missing, bail with a clear message.
  if (!project.summaryJson || !project.summaryHash) {
    console.error(`No project summary yet — run inspect-project-summary first (or wait for a pipeline run).`);
    process.exit(1);
  }
  let summary: ProjectSummary;
  try {
    summary = JSON.parse(project.summaryJson) as ProjectSummary;
  } catch (e) {
    console.error(`summary_json is malformed: ${(e as Error).message}`);
    process.exit(1);
  }

  const decision = vectorsNeedRegeneration({
    searchVectorsJson: project.searchVectorsJson ?? null,
    searchVectorsSummaryHash: project.searchVectorsSummaryHash ?? null,
    searchVectorsGeneratedAt: project.searchVectorsGeneratedAt ?? null,
    searchVectorsPromptVersion: project.searchVectorsPromptVersion ?? null,
    currentSummaryHash: project.summaryHash,
  });
  console.error(`[inspect-vectors] user=${userId} project=${slug} regen=${decision.regen} reason=${decision.reason} prompt=${VECTORS_PROMPT_VERSION}`);

  const cfg = await resolveUserConfig(userId);
  const vectors = await withRunConfig(
    {
      llmPrimaryApiKey: cfg.llmPrimaryApiKey,
      llmPrimaryBaseUrl: cfg.llmPrimaryBaseUrl,
      llmPrimaryModel: cfg.llmPrimaryModel,
      deepseekApiKey: cfg.deepseekApiKey,
    },
    () => generateSearchVectors(summary, project.summaryHash!),
  );

  if (!vectors) {
    console.error(`[inspect-vectors] no vectors generated`);
    process.exit(1);
  }

  console.log(JSON.stringify(vectors, null, 2));

  if (persist) {
    await db
      .update(schema.projectProfiles)
      .set({
        searchVectorsJson: JSON.stringify(vectors),
        searchVectorsSummaryHash: project.summaryHash,
        searchVectorsGeneratedAt: new Date(),
        searchVectorsPromptVersion: VECTORS_PROMPT_VERSION,
      })
      .where(eq(schema.projectProfiles.id, project.id));
    console.error(`[inspect-vectors] persisted to project_profiles.id=${project.id}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
