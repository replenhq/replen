// One-shot backfill: rebuild the repo_quality aggregate from existing
// triage_events. Run once after deploying migration 0042 so the cross-user
// learning loop reflects ALL historical triages, not only ones recorded after
// the feature shipped. Idempotent — safe to re-run any time.
//
// Usage:
//   node --env-file=.env --import=tsx src/cli/backfill-repo-quality.ts
//   tsx src/cli/backfill-repo-quality.ts --dry      (count only, no writes)

import { db, schema } from "../db/client";
import { recomputeRepoQuality } from "../lib/repo-quality";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const dry = flag("dry");

  // Distinct repos that have any triage history — those are the only repos a
  // quality row can exist for.
  const rows = await db
    .selectDistinct({ repoId: schema.triageEvents.repoId })
    .from(schema.triageEvents);
  const repoIds = rows.map((r) => r.repoId);

  console.log(`[backfill] ${repoIds.length} repo(s) with triage history`);
  if (dry) {
    console.log("[backfill] --dry: no writes performed");
    return;
  }

  let done = 0;
  for (const repoId of repoIds) {
    await recomputeRepoQuality(repoId);
    done++;
    if (done % 50 === 0) console.log(`[backfill] ${done}/${repoIds.length}`);
  }
  console.log(`[backfill] done — recomputed ${done} repo_quality row(s)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("[backfill] failed:", e);
    process.exit(1);
  },
);
