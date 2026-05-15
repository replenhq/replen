import { chatCompletion, TRIAGE_MODEL } from "./llm";
import type { SafetyReport } from "../scanner/safety";
import { sanitizeUntrusted, UNTRUSTED_CONTENT_RULE } from "./guards";

export type TriageVerdict = {
  shouldReason: boolean;
  oneLiner: string;
  category: string;
};

const SYSTEM = `You are a fast triage filter for a personal open-source digest.
The reader is an indie developer hunting for *under-the-radar* tools and
libraries they could pull into their own projects. They are NOT looking for:
  - Product launches or marketing from big AI/cloud companies (Anthropic,
    OpenAI, Google, Microsoft, Vercel, Cloudflare, Supabase, Neon, etc.)
  - Established mega-projects (kubernetes, react, postgres, ffmpeg, etc.)
  - Documentation sites, tutorials, course material, awesome-* lists, scraped
    mirrors, joke repos, empty stubs
  - "AI SDK for company X" repos that are essentially client libraries for a
    big company's paid API
  - Whitepapers / model weights / research dumps with no integration story

DO keep small/new/personal projects (any star count) that look like a tool,
library, framework, or service the developer could actually plug in.

Decide:
1. Is this a real, distinct, integrate-able OSS project (not the kinds listed above)?
2. Could it plausibly be useful to a working software engineer who builds AI, web, and infra projects?
3. In one sentence, what is the project?

Output JSON only, no prose:
{"keep": boolean, "category": "string", "oneLiner": "string"}

Categories: ai-model, ai-agent, ai-tooling, dev-tooling, infra, web-framework, library, cli, data, security, observability, other.`;

export async function triage(safety: SafetyReport): Promise<TriageVerdict> {
  const userText = `Repo: ${safety.meta.owner}/${safety.meta.name}
Stars: ${safety.meta.stars} | Age: ${safety.ageDays}d | Last push: ${safety.daysSincePush}d ago | Contributors: ${safety.contributorCount}
Language: ${safety.meta.language ?? "?"} | License: ${safety.meta.license ?? "?"}
Description: ${safety.meta.description ?? "(none)"}

${sanitizeUntrusted(safety.readmeMd.slice(0, 8000), "REPO_README")}`;

  const res = await chatCompletion({
    model: TRIAGE_MODEL,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${SYSTEM}\n\n${UNTRUSTED_CONTENT_RULE}` },
      { role: "user", content: userText },
    ],
  });

  const text = res.choices[0]?.message?.content ?? "";
  return parseTriage(text);
}

function parseTriage(text: string): TriageVerdict {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { shouldReason: false, oneLiner: "(triage parse failed)", category: "other" };
  try {
    const o = JSON.parse(jsonMatch[0]);
    return {
      shouldReason: !!o.keep,
      oneLiner: String(o.oneLiner ?? "").slice(0, 280),
      category: String(o.category ?? "other"),
    };
  } catch {
    return { shouldReason: false, oneLiner: "(triage parse failed)", category: "other" };
  }
}
