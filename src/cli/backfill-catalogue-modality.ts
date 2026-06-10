// One-shot backfill: populate catalogue_repos.modality from each repo's GitHub
// topics (deterministic, free — no LLM). Run once after migration 0049 so the
// cross-modal gate has signal on the EXISTING catalogue immediately, rather than
// waiting for each repo to be re-classified on its next refresh cycle. The LLM
// classify pass (which also fills modality) reconciles anything topics miss as
// the builder refreshes capabilities round-robin. Idempotent — only writes rows
// whose computed modality differs from what's stored.
//
// Usage:
//   node --env-file=.env --import=tsx src/cli/backfill-catalogue-modality.ts
//   tsx src/cli/backfill-catalogue-modality.ts --dry      (count only, no writes)

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { modalityFromTopics } from "../projects/modality";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const dry = flag("dry");
  const rows = await db
    .select({ id: schema.catalogueRepos.id, topics: schema.catalogueRepos.topics, modality: schema.catalogueRepos.modality })
    .from(schema.catalogueRepos);

  console.log(`[backfill] ${rows.length} catalogue repos`);
  let updated = 0;
  let tagged = 0;
  for (const r of rows) {
    let topics: string[] = [];
    try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { topics = []; }
    const mods = modalityFromTopics(topics);
    if (mods.length === 0) continue; // nothing to set — leave NULL (gate stays open)
    tagged++;
    const json = JSON.stringify(mods);
    if (r.modality === json) continue; // already correct
    if (!dry) {
      await db.update(schema.catalogueRepos).set({ modality: json }).where(eq(schema.catalogueRepos.id, r.id));
    }
    updated++;
  }
  console.log(`[backfill] ${tagged} repos have a topic-derivable modality; ${updated} ${dry ? "would be" : ""} updated`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
