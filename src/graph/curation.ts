// Shared capability-curation application.
//
// curateCapability (src/app/atlas/actions.ts) persists per-user rules —
// delete / rename / merge / confirm — keyed by a normalized capability label.
// build.ts re-applies them on every graph rebuild so the graph is
// "regeneration-proof". But other read paths (recall, the semantic map) read
// project_profiles.facetEmbeddings RAW, so a deleted/renamed capability would
// resurrect there after facets regenerate. This helper lets those paths apply
// the exact same mapping build.ts does, from one place.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";

export type CurationRule = { action: string; target: string | null };

// Same normalization curateCapability uses to key the rules (normCap).
const normCap = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function loadCurationMap(userId: number): Promise<Map<string, CurationRule>> {
  const rows = await db
    .select()
    .from(schema.capabilityCurations)
    .where(eq(schema.capabilityCurations.userId, userId));
  return new Map(rows.map((c) => [c.normLabel, { action: c.action, target: c.target ?? null }]));
}

// Resolve a stored facet label against the curation rules. Returns null when the
// capability was deleted (caller should drop it), otherwise the effective label
// (rename/merge target applied) and provenance (confirm upgrades to grounded).
export function applyCuration(
  label: string,
  provenance: string,
  byKey: Map<string, CurationRule>,
): { label: string; provenance: string } | null {
  const rule = byKey.get(normCap(label));
  if (!rule) return { label, provenance };
  if (rule.action === "delete") return null;
  let effLabel = label;
  let effProvenance = provenance;
  if ((rule.action === "rename" || rule.action === "merge") && rule.target) effLabel = rule.target;
  if (rule.action === "confirm") effProvenance = "grounded";
  return { label: effLabel, provenance: effProvenance };
}
