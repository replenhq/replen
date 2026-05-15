// LLM clients. Two providers wired:
//   - DeepSeek (cheap, used for triage + low-sensitivity reasoning)
//   - Anthropic (Claude, used for HIGH-sensitivity projects so confidential
//     architecture stays inside Anthropic's terms; not sent to DeepSeek in China)
//
// Both expose the same minimal ChatResponse shape so reason.ts can stay provider-agnostic.

const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "deepseek-v4-flash";
export const REASONING_MODEL = process.env.REASONING_MODEL ?? "deepseek-v4-flash";
// Used for high-sensitivity projects routed to Claude.
export const REASONING_MODEL_HIGH = process.env.REASONING_MODEL_HIGH ?? "claude-opus-4-7";

export type Provider = "deepseek" | "anthropic";

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

// ─────────────────────────────────────────────────────────────
// Per-run usage tracking. The pipeline calls beginUsageTracking()
// before doing any LLM work and endUsageTracking() to drain the totals.
// ─────────────────────────────────────────────────────────────

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
  return !!process.env.ANTHROPIC_API_KEY;
}

// ─────────────────────────────────────────────────────────────
// DeepSeek (OpenAI-shaped JSON)
// ─────────────────────────────────────────────────────────────
async function deepseekCompletion(req: ChatRequest, opts: { timeoutMs?: number; retries?: number }): Promise<ChatResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const retries = opts.retries ?? 3;

  const body = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    response_format: req.response_format,
  };

  return doWithRetry(
    () =>
      fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      }),
    "deepseek",
    timeoutMs,
    retries
  );
}

// ─────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────
async function anthropicCompletion(req: ChatRequest, opts: { timeoutMs?: number; retries?: number }): Promise<ChatResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set (required for high-sensitivity projects)");
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const retries = opts.retries ?? 2;

  // Split system messages out — Anthropic takes them as a top-level field, not in messages.
  const systemMsgs = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const userAssistant = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

  // Anthropic doesn't have a native response_format=json_object knob. Force JSON by
  // prefilling the assistant turn with "{" and adding a stop sequence is overkill;
  // adding a clear instruction in the system message is enough given our prompts.
  const jsonNote = req.response_format?.type === "json_object" ? "\n\nReply with a single JSON object only. No prose before or after." : "";

  const body = {
    model: req.model,
    max_tokens: req.max_tokens ?? 4096,
    system: systemMsgs + jsonNote,
    messages: userAssistant,
    temperature: req.temperature,
  };

  return doWithRetry(
    async () => {
      const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      // Convert Anthropic shape -> ChatResponse before returning to the retry helper.
      // We need to make this fetch return JSON the helper can parse uniformly, so wrap.
      if (!res.ok) return res;
      const j = (await res.json()) as any;
      const text = (j.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("");
      const adapted = {
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

// ─────────────────────────────────────────────────────────────
// Shared retry helper
// ─────────────────────────────────────────────────────────────
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
        throw new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
      }
      return (await res.json()) as ChatResponse;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
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
