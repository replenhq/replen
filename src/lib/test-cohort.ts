// The synthetic test cohort: users with role='test'.
//
// These users run the FULL real product — their own matching, facets,
// calibration, taste, Atlas, defer re-checks — exactly like a real user.
// They are excluded ONLY from CROSS-USER consensus signals, so a cohort we
// control can never manufacture agreement that real users see. The gated
// signals (Phase 0):
//   - catalogue k-anon          (scheduler/run-once.ts refreshCatalogueStep)
//   - endorsement promotion     (lib/cross-user-promote.ts)
//   - repo_quality aggregate    (lib/repo-quality.ts recomputeRepoQuality)
//                               → which feeds global-demote + cross-user leaps
//   - modality suppression      (lib/triage-memory.ts loadModalitySuppressions)
//
// Per-user signals are deliberately NOT gated — a test user's own data driving
// its own results is correct and never leaks: calibration, taste,
// outcome-priors, facet coverage, Atlas graph, defer re-checks, and the
// inventory route's own self-scoped triage read. The eval harness
// (cli/eval-matching.ts) also intentionally includes test labels — that's the
// data we generated it to measure.

import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";

// Ids of users flagged role='test'. Small set (we create them); callers cache
// it for the duration of a single computation rather than per-row.
export async function testUserIds(): Promise<Set<number>> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, "test"));
  return new Set(rows.map((r) => r.id));
}
