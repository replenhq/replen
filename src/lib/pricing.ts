// Per-model token pricing in USD per 1,000,000 tokens.
// Approximate rates — review against https://artificialanalysis.ai/leaderboards/models
// and the provider's own pricing page periodically.
//
// Cost = (inputTokens * inputPer1M + outputTokens * outputPer1M) / 1_000_000.

export type ModelPrice = { inputPer1M: number; outputPer1M: number };

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // DeepSeek — discount tier; flash is what we use for triage + low-sensitivity reasoning.
  "deepseek-v4-flash": { inputPer1M: 0.07, outputPer1M: 1.10 },
  "deepseek-v4-pro":   { inputPer1M: 0.27, outputPer1M: 1.10 },
  // Anthropic Claude Opus — used for high-sensitivity projects.
  "claude-opus-4-7":   { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-sonnet-4-6": { inputPer1M: 3.00, outputPer1M: 15.00 },
};

export function priceFor(model: string): ModelPrice | undefined {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // tolerate suffixed variants like "claude-opus-4-7-20260101"
  const prefix = Object.keys(MODEL_PRICING).find((m) => model.startsWith(m));
  return prefix ? MODEL_PRICING[prefix] : undefined;
}

export function costUsd(usage: { model: string; inputTokens: number; outputTokens: number }): number {
  const p = priceFor(usage.model);
  if (!p) return 0;
  return (usage.inputTokens * p.inputPer1M + usage.outputTokens * p.outputPer1M) / 1_000_000;
}

export function totalCostUsd(rows: Array<{ model: string; inputTokens: number; outputTokens: number }>): number {
  return rows.reduce((acc, r) => acc + costUsd(r), 0);
}
