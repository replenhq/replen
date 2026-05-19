// Single source of truth for "which LLM slot does this project's
// content go through?". Read by everything that makes an LLM call
// touching project content — prune-suggester, synthesise-insight,
// activity-summary, project-summarize.
//
// Rule:
//   project.llmProvider === "deepseek"  → "deepseek"    (explicit override)
//   project.llmProvider === "anthropic" → "anthropic"   (explicit override)
//   project.llmProvider === "auto" / null:
//     project.sensitivity === "high"    → "anthropic"
//     otherwise                         → "deepseek"
//
// The /projects UI's "effective" column already computes this exact
// rule for display. Centralising it here so the LLM caller side
// matches what the user sees in their settings — the previous
// behaviour ignored the override and routed purely on sensitivity,
// which broke for users who set sensitivity=high projects to
// llmProvider=deepseek (e.g. testing without an Anthropic key).

export type ProviderInput = {
  sensitivity?: string | null;
  llmProvider?: string | null;
};

export function resolveProvider(project: ProviderInput): "deepseek" | "anthropic" {
  const override = project.llmProvider;
  if (override === "deepseek" || override === "anthropic") return override;
  return project.sensitivity === "high" ? "anthropic" : "deepseek";
}

// For multi-project operations (synthesis clusters spanning ≥2 projects):
// route through anthropic if ANY of the contributing projects resolves
// to anthropic, otherwise deepseek. Fail-closed by design — a single
// sensitive-and-not-overridden project in the cluster taints the
// whole insight.
export function resolveClusterProvider(projects: ProviderInput[]): "deepseek" | "anthropic" {
  return projects.some((p) => resolveProvider(p) === "anthropic") ? "anthropic" : "deepseek";
}
