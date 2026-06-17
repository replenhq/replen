// Targeted project regen — regenerate the summary (grounded capabilities +
// modality, PROMPT_VERSION 6) AND facet vectors (grounded descriptors, FACET
// scheme 3) for projects whose slug matches a filter, WITHOUT running the full
// pipeline (which also fetches candidate sources and can stall). Mirrors the
// summarize + refreshStaleProjectEmbeddings steps of src/scheduler/run-once.ts.
//
// Usage:
//   node --env-file=.env --import=tsx src/cli/regen-project.ts --match acme
//   tsx src/cli/regen-project.ts --match acme --user 1

import { and, eq, like } from "drizzle-orm";
import { db, schema } from "../db/client";
import { generateProjectSummary, PROMPT_VERSION, type ProjectSummary } from "../projects/summarize";
import { parseShapeJson } from "../projects/loader";
import { facetInputsFor, embedFacets } from "../projects/facets";
import { serialiseFacetEmbeddings } from "../lib/embeddings";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

async function main() {
  const match = arg("match", "");
  const userId = parseInt(arg("user", "1") ?? "1", 10);
  const rows = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      eq(schema.projectProfiles.included, true),
      match ? like(schema.projectProfiles.slug, `%${match}%`) : undefined,
    ));
  console.log(`[regen] ${rows.length} project(s) matching "${match}" for user ${userId}`);

  for (const p of rows) {
    try {
      const summary = await generateProjectSummary({
        name: p.name, slug: p.slug, readmeMd: p.readmeMd, claudeMd: p.claudeMd,
        techSummary: p.techSummary, agentReport: p.agentReport, shape: parseShapeJson(p.shapeJson),
      });
      if (!summary) { console.log(`  - ${p.slug}: no docs, skipped`); continue; }
      await db.update(schema.projectProfiles).set({
        summaryJson: JSON.stringify(summary),
        summaryHash: p.profileHash,
        summaryGeneratedAt: new Date(),
        summaryPromptVersion: PROMPT_VERSION,
      }).where(eq(schema.projectProfiles.id, p.id));

      let domainTags: string[] = [];
      if (p.tags) {
        try { const a = JSON.parse(p.tags); if (Array.isArray(a)) domainTags = a.filter((t): t is string => typeof t === "string"); } catch { /* no domain qualifier */ }
      }
      const { hash, inputs } = facetInputsFor({
        capabilities: summary.capabilities, capabilityTags: summary.capabilityTags,
        keyCapabilities: summary.keyCapabilities, readmeMd: p.readmeMd, claudeMd: p.claudeMd,
        projectName: p.name ?? p.slug, projectSlug: p.slug, purpose: summary.purpose, domainTags,
      });
      const facets = inputs.length > 0 ? await embedFacets(inputs) : [];
      await db.update(schema.projectProfiles).set({
        facetEmbeddings: facets.length > 0 ? serialiseFacetEmbeddings({ hash, facets }) : p.facetEmbeddings,
        updatedAt: new Date(),
      }).where(eq(schema.projectProfiles.id, p.id));

      const caps = (summary.capabilities ?? []).map((c) => `${c.tag}[${c.modality.join("/") || "—"}]`).join(", ");
      console.log(`  ✓ ${p.slug}: ${facets.length} facets · ${caps}`);
    } catch (e) {
      console.warn(`  ✗ ${p.slug}: ${(e as Error).message}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
