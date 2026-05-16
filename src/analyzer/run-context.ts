// Per-run config carried through the call stack via AsyncLocalStorage.
//
// Replaces the previous "mutate process.env around each run" pattern, which
// was unsafe under concurrency: two pipelines running for different users
// would race on the shared env, and user B's malicious LLM base URL could
// receive user A's API key (or vice versa). With AsyncLocalStorage the
// context is bound to the async call tree the run was started from, so a
// concurrent run sees its own config — never the other user's.
//
// Everything in here is OPTIONAL. When a field is unset, callers should
// fall back to process.env (legacy behaviour). The fields are named after
// the env vars they mirror, so the mapping at the read site is direct.

import { AsyncLocalStorage } from "node:async_hooks";

export type RunConfig = {
  // LLM credentials and routing.
  llmPrimaryApiKey?: string | null;
  llmPrimaryBaseUrl?: string | null;
  llmPrimaryModel?: string | null;
  llmSensitiveApiKey?: string | null;
  llmSensitiveBaseUrl?: string | null;
  llmSensitiveModel?: string | null;
  llmSensitiveWireFormat?: string | null;
  // Legacy aliases (some users haven't re-saved settings since the schema migration).
  deepseekApiKey?: string | null;
  anthropicApiKey?: string | null;
  // GitHub PAT used by the pipeline's read path.
  githubToken?: string | null;
  // Source-handle overrides consumed by fetchers.
  redditSubs?: string | null;
  threadsHandles?: string | null;
  tiktokHandles?: string | null;
};

const store = new AsyncLocalStorage<RunConfig>();

export function withRunConfig<T>(cfg: RunConfig, fn: () => Promise<T>): Promise<T> {
  return store.run(cfg, fn);
}

export function currentRunConfig(): RunConfig | undefined {
  return store.getStore();
}

// Convenience reader: per-run override wins, then env, then fallback.
export function readRunOrEnv(key: keyof RunConfig, ...envKeys: string[]): string | undefined {
  const cfg = store.getStore();
  const fromCfg = cfg?.[key];
  if (fromCfg) return fromCfg;
  for (const k of envKeys) {
    const v = process.env[k];
    if (v) return v;
  }
  return undefined;
}

// True iff the per-run config has overridden the base URL for the named slot.
// Used to refuse a shared/env API key when the user is pointing the request
// at their own endpoint — without this, a malicious base URL could exfiltrate
// the operator's shared key.
export function hasUserBaseUrlOverride(slot: "primary" | "sensitive"): boolean {
  const cfg = store.getStore();
  if (!cfg) return false;
  return slot === "primary" ? !!cfg.llmPrimaryBaseUrl : !!cfg.llmSensitiveBaseUrl;
}
