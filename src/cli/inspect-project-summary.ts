// One-shot: generate a Stage-1 ProjectSummary for a single project and print
// it as JSON. Used for pre-pipeline manual inspection — verify the prompt
// produces useful output before wiring it into runs.
//
// Usage:
//   tsx src/cli/inspect-project-summary.ts --user=1 --slug=british-housing
//   tsx src/cli/inspect-project-summary.ts --user=1 --slug=british-housing --persist
//
// --persist also writes the result back to project_profiles. Without it,
// the summary is only printed (safe to run repeatedly without side effects).

import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { generateProjectSummary, needsRegeneration, summaryIsGrounded, preserveGroundedFields, PROMPT_VERSION } from "../projects/summarize";
import { parseShapeJson } from "../projects/loader";
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
    console.error(`Usage: tsx src/cli/inspect-project-summary.ts --user=<id> --slug=<project-slug> [--persist]`);
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

  const decision = needsRegeneration({
    summaryJson: project.summaryJson ?? null,
    summaryHash: project.summaryHash ?? null,
    summaryGeneratedAt: project.summaryGeneratedAt ?? null,
    summaryPromptVersion: project.summaryPromptVersion ?? null,
    currentProfileHash: project.profileHash,
  });
  console.error(`[inspect] user=${userId} project=${slug} regen=${decision.regen} reason=${decision.reason} prompt=${PROMPT_VERSION}`);

  const cfg = await resolveUserConfig(userId);
  const summary = await withRunConfig(
    {
      llmPrimaryApiKey: cfg.llmPrimaryApiKey,
      llmPrimaryBaseUrl: cfg.llmPrimaryBaseUrl,
      llmPrimaryModel: cfg.llmPrimaryModel,
      deepseekApiKey: cfg.deepseekApiKey,
    },
    () =>
      generateProjectSummary({
        name: project.name,
        slug: project.slug,
        readmeMd: project.readmeMd,
        claudeMd: project.claudeMd,
        techSummary: project.techSummary,
        shape: parseShapeJson(project.shapeJson),
      }),
  );

  if (!summary) {
    console.error(`[inspect] no summary generated (project has no docs and no techSummary)`);
    process.exit(1);
  }

  console.log(JSON.stringify(summary, null, 2));

  if (persist) {
    // Do-no-harm: a doc-recompute must not clobber GROUNDED (in-session
    // code-read) capabilities. Preserve the grounded fields on persist.
    if (summaryIsGrounded(project.summaryJson ?? null)) {
      preserveGroundedFields(summary, project.summaryJson ?? null);
      console.error(`[inspect] grounded — preserving in-session capabilities on persist`);
    }
    await db
      .update(schema.projectProfiles)
      .set({
        summaryJson: JSON.stringify(summary),
        summaryHash: project.profileHash,
        summaryGeneratedAt: new Date(),
        summaryPromptVersion: PROMPT_VERSION,
      })
      .where(eq(schema.projectProfiles.id, project.id));
    console.error(`[inspect] persisted to project_profiles.id=${project.id}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
