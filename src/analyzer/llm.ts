// Provider-agnostic LLM clients with two slots: Primary (OpenAI-compatible)
// for triage/low-sensitivity reasoning, Sensitive (Anthropic by default)
// for high-sensitivity projects. Per-user config flows via AsyncLocalStorage
// in run-context.ts so concurrent pipelines can't see each other's keys.
// Legacy env names DEEPSEEK_* / ANTHROPIC_* still work as aliases.

import { readRunOrEnv, hasUserBaseUrlOverride } from "./run-context";
import { resolveSafeWithPinnedDispatcher, validateWebhookUrl } from "../lib/url-guard";
import type { Agent } from "undici";

function primaryBase(): string {
  return (readRunOrEnv("llmPrimaryBaseUrl", "LLM_PRIMARY_BASE_URL", "DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com").replace(/\/$/, "");
}
function sensitiveBase(): string {
  return (readRunOrEnv("llmSensitiveBaseUrl", "LLM_SENSITIVE_BASE_URL", "ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com").replace(/\/$/, "");
}
function sensitiveWire(): string {
  return (readRunOrEnv("llmSensitiveWireFormat", "LLM_SENSITIVE_WIRE_FORMAT") ?? "anthropic").toLowerCase();
}

// SSRF guard + DNS-rebind defence for outbound LLM calls. Without this a
// user could point their base URL at 169.254.169.254 and exfiltrate the
// shared env API key.
async function safeLlmUrl(base: string, path: string, slot: "primary" | "sensitive"): Promise<{ url: URL; dispatcher: Agent }> {
  const target = base.replace(/\/$/, "") + path;
  const syntactic = validateWebhookUrl(target);
  if (!syntactic.ok) throw new Error(`refusing ${slot} LLM call: ${syntactic.error} (${target})`);
  const pinned = await resolveSafeWithPinnedDispatcher(syntactic.url);
  if (!pinned.ok) throw new Error(`refusing ${slot} LLM call: ${pinned.error} (${target})`);
  return { url: pinned.url, dispatcher: pinned.dispatcher };
}

// Refuse the operator's shared env key when the user has overridden the base
// URL — otherwise that key would be sent to whatever endpoint they picked.
function pickApiKey(slot: "primary" | "sensitive"): string {
  const cfgKey = slot === "primary"
    ? readRunOrEnv("llmPrimaryApiKey")
    : readRunOrEnv("llmSensitiveApiKey");
  if (cfgKey) return cfgKey;
  if (hasUserBaseUrlOverride(slot)) {
    throw new Error(
      `refusing to send shared ${slot} key to a user-overridden base URL — set a per-user API key on /settings to use a custom endpoint`
    );
  }
  if (slot === "primary") {
    const k = readRunOrEnv("deepseekApiKey", "LLM_PRIMARY_API_KEY", "DEEPSEEK_API_KEY");
    if (!k) throw new Error("LLM_PRIMARY_API_KEY (or legacy DEEPSEEK_API_KEY) not set");
    return k;
  }
  const k = readRunOrEnv("anthropicApiKey", "LLM_SENSITIVE_API_KEY", "ANTHROPIC_API_KEY");
  if (!k) throw new Error("LLM_SENSITIVE_API_KEY (or legacy ANTHROPIC_API_KEY) not set; required for high-sensitivity projects");
  return k;
}

// Module-load fallbacks for callers outside a withRunConfig() scope (CLI scripts).
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? process.env.LLM_PRIMARY_MODEL ?? "deepseek-v4-flash";
export const REASONING_MODEL = process.env.REASONING_MODEL ?? process.env.LLM_PRIMARY_MODEL ?? "deepseek-v4-flash";
export const REASONING_MODEL_HIGH = process.env.REASONING_MODEL_HIGH ?? process.env.LLM_SENSITIVE_MODEL ?? "claude-opus-4-7";

export type Provider = "deepseek" | "anthropic";

// Thrown when the LLM provider responds with a clear out-of-credits / quota
// signal (HTTP 402, "insufficient_balance", "insufficient_quota", etc.).
// These errors are NOT transient — retrying just wastes more calls — so the
// retry loop bails out immediately when it sees one. Callers (pipeline,
// scheduler) special-case this type to set pausedReason and surface a
// "add credits / switch provider" message in the UI + CLI.
export class LlmQuotaError extends Error {
  readonly slot: "primary" | "sensitive";
  readonly httpStatus: number;
  readonly detail: string;
  constructor(slot: "primary" | "sensitive", httpStatus: number, detail: string) {
    super(`${slot} LLM out of credits (HTTP ${httpStatus}): ${detail.slice(0, 200)}`);
    this.name = "LlmQuotaError";
    this.slot = slot;
    this.httpStatus = httpStatus;
    this.detail = detail.slice(0, 500);
  }
}

// Heuristic match across providers (DeepSeek, OpenAI, Anthropic, OpenRouter,
// Together, Groq). HTTP 402 is the universal billing-failure status; the body
// markers catch providers that prefer 429/400 for the same condition.
function isQuotaError(status: number, body: string): boolean {
  if (status === 402) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient balance") ||
    lower.includes("insufficient_balance") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("credit_balance_too_low") ||
    lower.includes("billing_hard_limit_reached") ||
    lower.includes("you have run out of credits") ||
    lower.includes("no_credit_balance")
  );
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" | "text" };
  provider?: Provider; // default: deepseek
};
export type ChatResponse = {
  id: string;
  choices: { message: { role: string; content: string }; finish_reason: string }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type AnthropicMessagesResponse = {
  id: string;
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
};

export async function chatCompletion(
  req: ChatRequest,
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<ChatResponse> {
  const provider = req.provider ?? "deepseek";
  const res = provider === "anthropic"
    ? await anthropicCompletion(req, opts)
    : await deepseekCompletion(req, opts);
  if (currentUsage && res.usage) {
    currentUsage.calls.push({
      provider,
      model: req.model,
      inputTokens: res.usage.prompt_tokens ?? 0,
      outputTokens: res.usage.completion_tokens ?? 0,
    });
  }
  return res;
}

// Per-run usage tracking. The pipeline calls beginUsageTracking()
// before doing any LLM work and endUsageTracking() to drain the totals.

export type LlmCall = {
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type UsageSummary = {
  deepseekInputTokens: number;
  deepseekOutputTokens: number;
  anthropicInputTokens: number;
  anthropicOutputTokens: number;
  calls: LlmCall[];
};

let currentUsage: { calls: LlmCall[] } | null = null;

export function beginUsageTracking(): void {
  currentUsage = { calls: [] };
}

export function endUsageTracking(): UsageSummary {
  const calls = currentUsage?.calls ?? [];
  currentUsage = null;
  const summary: UsageSummary = {
    deepseekInputTokens: 0,
    deepseekOutputTokens: 0,
    anthropicInputTokens: 0,
    anthropicOutputTokens: 0,
    calls,
  };
  for (const c of calls) {
    if (c.provider === "deepseek") {
      summary.deepseekInputTokens += c.inputTokens;
      summary.deepseekOutputTokens += c.outputTokens;
    } else if (c.provider === "anthropic") {
      summary.anthropicInputTokens += c.inputTokens;
      summary.anthropicOutputTokens += c.outputTokens;
    }
  }
  return summary;
}

export function hasAnthropicKey(): boolean {
  return !!(readRunOrEnv("llmSensitiveApiKey", "LLM_SENSITIVE_API_KEY", "ANTHROPIC_API_KEY")
    ?? readRunOrEnv("anthropicApiKey", "ANTHROPIC_API_KEY"));
}

// Primary slot (OpenAI-compatible /chat/completions wire format).
// Works with DeepSeek, OpenAI, Groq, Together, Fireworks, OpenRouter,
// local llama.cpp / ollama servers, anything that speaks OpenAI's chat API.
async function deepseekCompletion(req: ChatRequest, opts: { timeoutMs?: number; retries?: number }): Promise<ChatResponse> {
  const apiKey = pickApiKey("primary");
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const retries = opts.retries ?? 3;

  const body = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    response_format: req.response_format,
  };

  const pinned = await safeLlmUrl(primaryBase(), "/chat/completions", "primary");
  return doWithRetry(
    () =>
      fetch(pinned.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        dispatcher: pinned.dispatcher,
      } as any),
    "primary",
    timeoutMs,
    retries
  );
}

// Sensitive slot. Wire format defaults to Anthropic's /v1/messages.
// Set LLM_SENSITIVE_WIRE_FORMAT=openai-compatible to use the same OpenAI-shaped
// path as the primary slot (lets you route sensitive projects to e.g. a
// privately-hosted OpenAI-compatible model on infra you control).
async function anthropicCompletion(req: ChatRequest, opts: { timeoutMs?: number; retries?: number }): Promise<ChatResponse> {
  const apiKey = pickApiKey("sensitive");
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const retries = opts.retries ?? 2;

  // OpenAI-compatible path: same as the primary slot. Use when the sensitive
  // provider exposes /chat/completions instead of /v1/messages.
  const wire = sensitiveWire();
  if (wire === "openai-compatible" || wire === "openai") {
    const body = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      response_format: req.response_format,
    };
    const pinned = await safeLlmUrl(sensitiveBase(), "/chat/completions", "sensitive");
    return doWithRetry(
      () =>
        fetch(pinned.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          dispatcher: pinned.dispatcher,
        } as any),
      "sensitive",
      timeoutMs,
      retries
    );
  }

  // Anthropic /v1/messages: split system messages out (top-level field).
  const systemMsgs = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const userAssistant = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

  // Anthropic doesn't have a native response_format=json_object knob; a clear
  // instruction in the system message is enough given our prompts.
  const jsonNote = req.response_format?.type === "json_object" ? "\n\nReply with a single JSON object only. No prose before or after." : "";

  const body = {
    model: req.model,
    max_tokens: req.max_tokens ?? 4096,
    system: systemMsgs + jsonNote,
    messages: userAssistant,
    temperature: req.temperature,
  };

  const pinned = await safeLlmUrl(sensitiveBase(), "/v1/messages", "sensitive");
  return doWithRetry(
    async () => {
      const res = await fetch(pinned.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        dispatcher: pinned.dispatcher,
      } as any);
      // Convert Anthropic /v1/messages shape into ChatResponse for the retry helper.
      if (!res.ok) return res;
      const j = (await res.json()) as AnthropicMessagesResponse;
      const text = (j.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
      const adapted: ChatResponse = {
        id: j.id,
        choices: [
          {
            message: { role: "assistant", content: text },
            finish_reason: j.stop_reason ?? "stop",
          },
        ],
        usage: j.usage
          ? { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens, total_tokens: j.usage.input_tokens + j.usage.output_tokens }
          : undefined,
      };
      return new Response(JSON.stringify(adapted), { status: 200, headers: { "content-type": "application/json" } });
    },
    "anthropic",
    timeoutMs,
    retries
  );
}

// Shared retry helper
async function doWithRetry(
  fetchFn: () => Promise<Response>,
  label: string,
  timeoutMs: number,
  retries: number
): Promise<ChatResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await Promise.race([fetchFn(), neverResolves(ctrl)]);
      clearTimeout(t);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (isQuotaError(res.status, text)) {
          throw new LlmQuotaError(label as "primary" | "sensitive", res.status, text);
        }
        throw new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
      }
      return (await res.json()) as ChatResponse;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      // Quota errors are not transient — fail fast so the pipeline can stop
      // and the UI can prompt the user to top up.
      if (e instanceof LlmQuotaError) throw e;
      if (attempt === retries) break;
      const backoff = 1500 * (attempt + 1);
      console.warn(`[llm:${label}] attempt ${attempt + 1}/${retries + 1} failed: ${describe(e)}; retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

function neverResolves(ctrl: AbortController): Promise<Response> {
  return new Promise((_, rej) => {
    ctrl.signal.addEventListener("abort", () => rej(new Error("timeout")));
  });
}

function describe(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as any).message);
  return String(e);
}
