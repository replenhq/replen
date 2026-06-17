// Per-project field-quality check — the enforcement gate. Runs every pipeline
// run (see runPipelineForUser) and surfaces which projects are missing, stack-
// polluted, or thin on the grounding fields the matcher depends on. Shares its
// logic with the standalone audit (src/cli/audit-project-fields.ts).
//
// It does NOT mutate data: the mechanical repair (domain derived from purpose) is
// automatic via projectDomainContext on re-embed; the deeper richness (code-
// grounded capability descriptors + modality) only the in-session /replen-onboard
// agent can produce, since the server never sees code. So the gate's job is to
// make the gaps VISIBLE and point at the repos that need a local onboard.

import { isStackToken } from "../lib/embeddings";

export type QualityInput = {
  slug: string | null;
  summaryJson: string | null;
  tags: string | null;
  facetEmbeddings: string | null;
  embedding: string | null;
  depVersions: string | null;
  readmeMd: string | null;
  claudeMd: string | null;
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The grounding-field problems for one project, worst-first. Empty = healthy. */
export function projectQualityIssues(p: QualityInput): string[] {
  const issues: string[] = [];

  let hasSummary = false, purpose = "", caps = 0, capsDesc = 0;
  try {
    const s = p.summaryJson ? JSON.parse(p.summaryJson) : null;
    if (s) {
      hasSummary = true;
      purpose = typeof s.purpose === "string" ? s.purpose.trim() : "";
      const cs = arr(s.capabilities) as Array<{ descriptor?: string }>;
      caps = cs.length;
      capsDesc = cs.filter((c) => typeof c?.descriptor === "string" && c.descriptor.trim().length > 0).length;
    }
  } catch { /* malformed */ }

  let tags: string[] = [];
  try { const t = p.tags ? JSON.parse(p.tags) : null; if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
  const stack = tags.filter(isStackToken).length;
  const domainTags = tags.length - stack;

  const readmeLen = (p.readmeMd ?? "").length;
  const hasClaude = !!(p.claudeMd ?? "").trim();

  if (!hasSummary) issues.push("no summary");
  else if (!purpose) issues.push("no purpose");
  if (tags.length === 0) issues.push("no domain tags");
  else if (domainTags === 0) issues.push("domain is stack-only");
  if (caps > 0 && capsDesc === 0) issues.push("capabilities have no descriptors");
  if (!p.facetEmbeddings) issues.push("no facet vectors");
  if (!p.embedding) issues.push("no centroid");
  if (!p.depVersions) issues.push("no pinned versions");
  if (readmeLen < 300 && !hasClaude) issues.push("thin docs");

  return issues;
}

/** Compact run-event line summarising portfolio field-quality for a user. */
export function qualityGateSummary(results: Array<{ slug: string; issues: string[] }>): string | null {
  const bad = results.filter((r) => r.issues.length > 0);
  if (results.length === 0) return null;
  const tally = (k: string) => results.filter((r) => r.issues.includes(k)).length;
  const headline = `Field-quality gate: ${bad.length}/${results.length} project(s) below bar`;
  const breakdown = [
    tally("domain is stack-only") + tally("no domain tags") ? `${tally("domain is stack-only") + tally("no domain tags")} weak domain` : "",
    tally("no pinned versions") ? `${tally("no pinned versions")} no versions` : "",
    tally("capabilities have no descriptors") ? `${tally("capabilities have no descriptors")} bare capabilities` : "",
    tally("thin docs") ? `${tally("thin docs")} thin docs` : "",
  ].filter(Boolean).join(", ");
  // Name the few worst so the user knows where to run /replen-onboard.
  const worst = bad.sort((a, b) => b.issues.length - a.issues.length).slice(0, 5)
    .map((r) => `${r.slug} (${r.issues.join("; ")})`).join(" · ");
  return `${headline}${breakdown ? ` — ${breakdown}` : ""}.${worst ? ` Worst: ${worst}. Run /replen-onboard on these to ground them.` : ""}`;
}
