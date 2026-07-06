/**
 * ingestion-guards.ts — hard-failing Zod validation barriers for Replen's
 * three trust borders.
 *
 * Intended in-repo home: src/lib/ingestion-guards.ts (the absolute type
 * import below becomes `@/fetchers/types`).
 *
 *   1. API border       — request bodies on POST /api/ingest and
 *                         POST /api/triage (plus the MCP write tools in
 *                         mcp/src/server.ts that proxy them).
 *   2. CLI border       — project registration / capability reports /
 *                         dep-version reports posted by `npx replen` and
 *                         @replen/mcp (report/purpose/goals/capabilities
 *                         caps mirror mcp/src/server.ts).
 *   3. Ingestion border — scraped/fetched candidates (src/fetchers/*: HN,
 *                         gh-trending, reddit, threads, tiktok, the watch
 *                         lenses) BEFORE they reach the candidates table,
 *                         the embedding pass, Atlas Tiles, the digest email
 *                         or the in-session footnote.
 *
 * Design rules:
 *   - Every string and every array carries a rigid size cap. Unbounded text
 *     flows into the embeddings API (denial-of-wallet), SQLite rows, email
 *     bodies and markdown surfaces (resource exhaustion), so nothing is
 *     accepted "as long as it parses".
 *   - Validation HARD-FAILS (schema.parse throws / safeParse returns error).
 *     No silent `.slice()` truncation at this layer — truncation belongs to
 *     the render layer, the border rejects.
 *   - The injection scanner runs BEFORE scraped data reaches downstream
 *     components. Two profiles: `scalar` (titles, authors, topics, ids —
 *     strict, includes command-injection footprints) and `prose` (README
 *     heads, agent writeups — READMEs legitimately contain code, entities
 *     and inline HTML like <details>, so only script primitives, event
 *     handlers, dangerous schemes and encoded-script survive as blockers).
 *
 * Caps mirror the ones already enforced ad hoc in the codebase:
 *   - src/app/api/ingest/route.ts  (url 2048 / title 200 / note 1000)
 *   - src/app/api/triage/route.ts  (oneLine 280 / writeup 16 KB bytes,
 *                                   20 000 chars / facet 120 / deps 20 /
 *                                   owner-name regex)
 *   - mcp/src/server.ts            (report 32 KB / purpose 2000 /
 *                                   goals 12x200 / capability tag 120 /
 *                                   descriptor 800 / modality 8x40 /
 *                                   paths 5x200 / oneLine 280)
 */

import { z } from "zod";
// Real repo type — proves at compile time that the ingestion barrier's output
// is assignable to what src/fetchers/index.ts consumes. In-repo this import
// becomes: import type { FetchedCandidate } from "@/fetchers/types";
import type { FetchedCandidate } from "@/fetchers/types";

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Size caps — single source of truth
 * ────────────────────────────────────────────────────────────────────────── */

export const LIMITS = {
  // URLs (matches /api/ingest's explicit 2048 cap)
  URL_MAX: 2048,

  // Fetched-candidate (ingestion border) caps
  SOURCE_MAX: 40,
  SOURCE_ITEM_ID_MAX: 256,
  TITLE_MAX: 300,
  AUTHOR_MAX: 120,
  LANGUAGE_MAX: 40,
  TOPIC_MAX: 60,
  TOPICS_MAX: 30,
  README_HEAD_MAX: 4_000, // fetchers store ~1.5k cleaned chars; hard ceiling 4k
  RAW_JSON_MAX_BYTES: 64 * 1024,
  BATCH_MAX: 500, // largest legit fetch is HN's 200/page
  SCORE_MIN: -1_000_000, // reddit scores can go negative
  SCORE_MAX: 100_000_000,

  // /api/ingest caps (route currently slices; barrier rejects instead)
  INGEST_TITLE_MAX: 200,
  INGEST_NOTE_MAX: 1000,

  // /api/triage caps (mirror route constants MAX_ONELINE_CHARS / MAX_WRITEUP_BYTES)
  ONELINE_MAX: 280,
  WRITEUP_MAX_BYTES: 16 * 1024,
  WRITEUP_MAX_CHARS: 20_000,
  SESSION_ID_MAX: 200,
  FACET_MAX: 120,
  DEPS_LIST_MAX: 20,

  // CLI / MCP registration caps (mirror mcp/src/server.ts)
  REPORT_MAX_CHARS: 40_000,
  REPORT_MAX_BYTES: 32 * 1024,
  PURPOSE_MAX: 2_000,
  GOALS_MAX: 12,
  GOAL_MAX: 200,
  CAPABILITIES_MAX: 64,
  CAP_TAG_MAX: 120,
  CAP_DESCRIPTOR_MAX: 800,
  CAP_MODALITY_ITEMS_MAX: 8,
  CAP_MODALITY_MAX: 40,
  CAP_PATHS_MAX: 5,
  CAP_PATH_MAX: 200,
  PROJECT_SLUG_MAX: 120,

  // dep-version reports (Record<depName, version>)
  DEP_NAME_MAX: 214, // npm's own name ceiling
  DEP_VERSION_MAX: 64,
  DEP_RECORD_MAX_KEYS: 500,

  // embeddings (text-embedding-3-small)
  EMBEDDING_DIM: 1536,

  // Injection scanner never walks more than this many chars (defense in
  // depth: schema length caps run first, so this is a backstop).
  SCAN_MAX_CHARS: 100_000,
} as const;

const INT32_MAX = 2_147_483_647;

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. Injection scanner — the ingestion sanitizer barrier
 * ────────────────────────────────────────────────────────────────────────── */

export type AttackClass =
  | "script-tag" // <script, <iframe, <svg/onload sinks, image trackers…
  | "event-handler" // on*= handlers, srcdoc=, formaction=, xlink:href=
  | "dangerous-scheme" // javascript:, vbscript:, file:, whitespace-split variants
  | "data-uri" // data:text/html, data:image/svg+xml, data:*;base64
  | "html-entity" // unexpected numeric char refs / dangerous named entities
  | "encoded-script" // any of the above hiding behind one layer of entity encoding
  | "command-substitution" // $( … ), ${IFS}/${…}, backticked shell payloads
  | "shell-chain" // ; rm -rf, && curl, | bash …
  | "control-char" // NUL and other C0/C1 controls
  | "invisible-unicode" // zero-width, bidi overrides, BOM, soft hyphen
  | "path-traversal"; // ../ segments in id/path-shaped fields

export type InjectionSignal = { cls: AttackClass; sample: string };
export type SanitizeProfile = "scalar" | "prose";

// Structural character classes (also used by the string helpers).
// C0 controls except \t \n \r, plus DEL.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// Zero-width chars, bidi overrides/isolates, BOM, soft hyphen — the
// steganography/spoofing set sanitizeForMarkdown also strips.
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

// HTML tags that are script primitives / trackers. The prose profile uses the
// core set only (READMEs legitimately contain <img>, <details>, <br>…).
const SCRIPT_TAG_CORE_RE =
  /<\s*\/?\s*(?:script|iframe|object|embed|base|meta|form|applet|frame|frameset)\b/i;
const SCRIPT_TAG_STRICT_RE =
  /<\s*\/?\s*(?:script|iframe|object|embed|base|meta|link|form|style|template|applet|frame|frameset|svg|math|img|picture|source|video|audio)\b/i;
const EVENT_HANDLER_RE = /\bon[a-z]{2,30}\s*=|\b(?:srcdoc|formaction|xlink:href)\s*=/i;
const DANGEROUS_SCHEME_RE = /\b(?:javascript|vbscript|livescript|mocha|file)\s*:/i;
// Catches whitespace-split scheme smuggling ("java\tscript:", "java script:")
// the way the URL parser normalises it.
const SPLIT_SCHEME_RE = /\bj\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:|\bv\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i;
const DATA_URI_RE = /\bdata:\s*[a-z]+\/[a-z0-9.+-]+|\bdata:[^,\n]{0,100};base64/i;
const NUMERIC_ENTITY_RE = /&#x[0-9a-f]{1,6};?|&#[0-9]{1,7};?/i;
const NAMED_ENTITY_RE =
  /&(?:lt|gt|quot|apos|amp|sol|bsol|colon|semi|grave|dollar|lpar|rpar|tab|newline|nbsp);/i;
const CMD_SUB_RE = /\$\(|\$\{\s*[A-Za-z_(]/;
// Backticked content containing shell metachars or a known shell verb.
const BACKTICK_SHELL_RE =
  /`[^`\n]{0,200}(?:[;|&]|\$\(|\b(?:rm|curl|wget|nc|ncat|sh|bash|zsh|python[0-9.]*|perl|eval|exec|chmod|mkfifo)\b)[^`\n]{0,200}`/i;
// A chain operator followed by a shell verb. Single "&" is excluded on
// purpose ("Tips & Tricks" is a legit title); ";", "&&", "|", "||" are not.
const SHELL_CHAIN_RE =
  /(?:;|&&|\|{1,2})\s*(?:rm|curl|wget|nc|ncat|sh|bash|zsh|dash|python[0-9.]*|perl|ruby|php|node|eval|exec|chmod|chown|mkfifo|base64|xargs)\b/i;

const ENTITY_NAMED_MAP: Record<string, string> = {
  lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", sol: "/", bsol: "\\",
  colon: ":", semi: ";", grave: "`", dollar: "$", lpar: "(", rpar: ")",
  tab: "\t", newline: "\n", nbsp: " ",
};

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "�";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "�";
  }
}

/** One decoding pass over numeric + core named HTML entities. Used to catch
 * `&lt;script&gt;` / `&#106;avascript:` style single-layer obfuscation. */
export function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});?/g, (_, d: string) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]{2,8});/gi, (m, name: string) => ENTITY_NAMED_MAP[name.toLowerCase()] ?? m);
}

type PatternRow = { cls: AttackClass; re: RegExp; profiles: readonly SanitizeProfile[] };

const PATTERNS: readonly PatternRow[] = [
  { cls: "script-tag", re: SCRIPT_TAG_STRICT_RE, profiles: ["scalar"] },
  { cls: "script-tag", re: SCRIPT_TAG_CORE_RE, profiles: ["prose"] },
  { cls: "event-handler", re: EVENT_HANDLER_RE, profiles: ["scalar", "prose"] },
  { cls: "dangerous-scheme", re: DANGEROUS_SCHEME_RE, profiles: ["scalar", "prose"] },
  { cls: "dangerous-scheme", re: SPLIT_SCHEME_RE, profiles: ["scalar", "prose"] },
  { cls: "data-uri", re: DATA_URI_RE, profiles: ["scalar", "prose"] },
  // Unexpected entities: fetchers decode HTML before persisting, so a raw
  // entity in a scraped scalar means double-encoding — always a red flag.
  // Prose (raw markdown READMEs) legitimately contains &amp;/&nbsp;, so the
  // entity classes are scalar-only; the encoded-script re-scan below still
  // catches entity-hidden script in BOTH profiles.
  { cls: "html-entity", re: NUMERIC_ENTITY_RE, profiles: ["scalar"] },
  { cls: "html-entity", re: NAMED_ENTITY_RE, profiles: ["scalar"] },
  { cls: "command-substitution", re: CMD_SUB_RE, profiles: ["scalar"] },
  { cls: "command-substitution", re: BACKTICK_SHELL_RE, profiles: ["scalar"] },
  { cls: "shell-chain", re: SHELL_CHAIN_RE, profiles: ["scalar"] },
  { cls: "control-char", re: CONTROL_RE, profiles: ["scalar", "prose"] },
  { cls: "invisible-unicode", re: INVISIBLE_RE, profiles: ["scalar", "prose"] },
  { cls: "path-traversal", re: TRAVERSAL_RE, profiles: ["scalar"] },
];

// Script primitives re-checked on the entity-decoded text.
const DECODED_RESCAN: readonly RegExp[] = [
  SCRIPT_TAG_CORE_RE,
  EVENT_HANDLER_RE,
  DANGEROUS_SCHEME_RE,
  SPLIT_SCHEME_RE,
  DATA_URI_RE,
];

/**
 * Scan a string for injection footprints. Returns one signal per attack
 * class matched (empty array = clean). Deterministic, regex-only, no LLM.
 */
export function scanForInjection(
  input: string,
  profile: SanitizeProfile = "scalar",
): InjectionSignal[] {
  const s = input.slice(0, LIMITS.SCAN_MAX_CHARS);
  const signals: InjectionSignal[] = [];
  const seen = new Set<AttackClass>();

  for (const row of PATTERNS) {
    if (!row.profiles.includes(profile) || seen.has(row.cls)) continue;
    const m = row.re.exec(s);
    if (m) {
      seen.add(row.cls);
      signals.push({ cls: row.cls, sample: m[0].slice(0, 40) });
    }
  }

  // Decode one layer of HTML entities and re-scan for script primitives so
  // `&lt;script&gt;` / `&#106;avascript:` can't sneak past the raw pass.
  const decoded = decodeEntitiesOnce(s);
  if (decoded !== s && !seen.has("encoded-script")) {
    for (const re of DECODED_RESCAN) {
      const m = re.exec(decoded);
      if (m) {
        signals.push({ cls: "encoded-script", sample: m[0].slice(0, 40) });
        break;
      }
    }
  }

  return signals;
}

/** Hard-failing form: throws with the matched attack classes in the message. */
export function assertNoInjection(
  input: string,
  profile: SanitizeProfile = "scalar",
  label = "value",
): void {
  const signals = scanForInjection(input, profile);
  if (signals.length > 0) {
    const classes = signals.map((x) => x.cls).join(", ");
    throw new Error(`injection footprint in ${label}: ${classes}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. Reusable helper set — safeString / safeText / safeArray / boundedRecord
 * ────────────────────────────────────────────────────────────────────────── */

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Refinement helper: cap the UTF-8 byte length (parity with the existing
 * Buffer.byteLength checks in /api/triage), portable to the edge runtime. */
export const maxBytes = (n: number) => (s: string) => utf8Bytes(s) <= n;

export type SafeStringOpts = { min?: number; pattern?: RegExp };

/**
 * Single-line bounded string: length-capped, no newlines/tabs, no C0/C1
 * control chars, no zero-width/bidi trickery. Structural only — pair with
 * scrapedScalar()/agentText() for content scanning.
 */
export function safeString(max: number, opts: SafeStringOpts = {}) {
  return z
    .string()
    .min(opts.min ?? 0)
    .max(max)
    .refine((s) => !/[\r\n\t]/.test(s), { message: "newlines/tabs not allowed in single-line field" })
    .refine((s) => !CONTROL_RE.test(s), { message: "control characters not allowed" })
    .refine((s) => !INVISIBLE_RE.test(s), { message: "invisible/bidi unicode not allowed" })
    .refine((s) => (opts.pattern ? opts.pattern.test(s) : true), {
      message: opts.pattern ? `must match ${opts.pattern}` : "invalid",
    });
}

/** Multi-line bounded text: \n \r \t allowed, other controls + invisibles rejected. */
export function safeText(max: number, opts: { min?: number } = {}) {
  return z
    .string()
    .min(opts.min ?? 0)
    .max(max)
    .refine((s) => !CONTROL_RE.test(s), { message: "control characters not allowed" })
    .refine((s) => !INVISIBLE_RE.test(s), { message: "invisible/bidi unicode not allowed" });
}

/** Bounded array. Rejects (never truncates) past maxItems. */
export function safeArray<T extends z.ZodTypeAny>(
  item: T,
  maxItems: number,
  opts: { min?: number } = {},
) {
  return z.array(item).min(opts.min ?? 0).max(maxItems);
}

const FORBIDDEN_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type BoundedRecordOpts<V extends z.ZodTypeAny> = {
  keyMax: number;
  keyPattern?: RegExp;
  maxKeys: number;
  value: V;
};

/**
 * Bounded string-keyed record: key length + charset capped, key count capped,
 * prototype-pollution key names rejected, keys injection-scanned.
 *
 * The prototype-pollution check MUST run on the RAW input, before Zod's
 * record parse: z.record copies entries into a fresh object via assignment,
 * and assigning a "__proto__" own-property (which JSON.parse happily mints)
 * SETS the copy's prototype instead of creating a key — by superRefine time
 * the hostile key has silently vanished. Hence the piped pre-check on
 * Object.getOwnPropertyNames of the original value.
 */
export function boundedRecord<V extends z.ZodTypeAny>(opts: BoundedRecordOpts<V>) {
  const inner = z
    .record(z.string().max(opts.keyMax), opts.value)
    .superRefine((rec, ctx) => {
      const keys = Object.keys(rec);
      if (keys.length > opts.maxKeys) {
        ctx.addIssue({ code: "custom", message: `too many keys: ${keys.length} > ${opts.maxKeys}` });
        return;
      }
      for (const k of keys) {
        if (opts.keyPattern && !opts.keyPattern.test(k)) {
          ctx.addIssue({ code: "custom", message: `key "${k.slice(0, 40)}" fails ${opts.keyPattern}` });
          continue;
        }
        const signals = scanForInjection(k, "scalar");
        if (signals.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `injection footprint in key "${k.slice(0, 40)}": ${signals.map((x) => x.cls).join(", ")}`,
          });
        }
      }
    });
  return z
    .custom<Record<string, unknown>>(
      (v) => {
        // Non-objects pass through so the record schema reports the proper
        // type error; arrays likewise.
        if (typeof v !== "object" || v === null || Array.isArray(v)) return true;
        for (const k of Object.getOwnPropertyNames(v)) {
          if (FORBIDDEN_RECORD_KEYS.has(k)) return false;
        }
        return true;
      },
      { message: "forbidden key (prototype pollution)" },
    )
    .pipe(inner);
}

/** Absolute http(s) URL: length-capped, scheme allowlisted, no embedded
 * credentials, no control/invisible chars. */
export function safeUrl(max: number = LIMITS.URL_MAX) {
  return z
    .string()
    .min(1)
    .max(max)
    .superRefine((s, ctx) => {
      if (CONTROL_RE.test(s) || INVISIBLE_RE.test(s) || /[\s]/.test(s)) {
        ctx.addIssue({ code: "custom", message: "whitespace/control characters in URL" });
        return;
      }
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        ctx.addIssue({ code: "custom", message: "not a valid absolute URL" });
        return;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        ctx.addIssue({ code: "custom", message: `scheme "${u.protocol}" not allowed (http/https only)` });
      }
      if (u.username || u.password) {
        ctx.addIssue({ code: "custom", message: "credentials in URL not allowed" });
      }
    });
}

/** github.com repo URL only (candidate.githubUrl). */
export function githubUrlSchema(max: number = LIMITS.URL_MAX) {
  return safeUrl(max).refine(
    (s) => {
      try {
        const h = new URL(s).hostname.toLowerCase();
        return h === "github.com" || h === "www.github.com";
      } catch {
        return false;
      }
    },
    { message: "must be a github.com URL" },
  );
}

// Exactly the owner/name shape /api/triage already enforces before minting
// rows in the global repos table.
export const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const githubRepoRef = safeString(140, { min: 3, pattern: GITHUB_REPO_RE });

/** Scraped single-line scalar (title/author/topic/id): structural caps +
 * full scalar-profile injection scan. */
export function scrapedScalar(max: number, opts: SafeStringOpts = {}) {
  return safeString(max, opts).superRefine((s, ctx) => {
    for (const sig of scanForInjection(s, "scalar")) {
      ctx.addIssue({ code: "custom", message: `injection footprint (${sig.cls}): ${sig.sample}` });
    }
  });
}

/** Scraped/agent prose (README head, writeup): multi-line, prose-profile scan
 * (code fences / shell examples / entities in READMEs stay legal; script
 * primitives, handlers, dangerous schemes and encoded-script do not). */
export function scrapedProse(max: number, opts: { min?: number } = {}) {
  return safeText(max, opts).superRefine((s, ctx) => {
    for (const sig of scanForInjection(s, "prose")) {
      ctx.addIssue({ code: "custom", message: `injection footprint (${sig.cls}): ${sig.sample}` });
    }
  });
}

/** Repo-relative evidence path (capability `paths`): no traversal, no
 * absolute paths, conservative charset. */
export const repoRelativePath = safeString(LIMITS.CAP_PATH_MAX, {
  min: 1,
  pattern: /^[A-Za-z0-9][A-Za-z0-9._\-/ +@#()\[\]]*$/,
})
  .refine((s) => !TRAVERSAL_RE.test(s), { message: "path traversal not allowed" })
  .refine((s) => !s.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(s), {
    message: "absolute paths not allowed",
  });

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. Ingestion border — scraped candidates (src/fetchers/*)
 * ────────────────────────────────────────────────────────────────────────── */

// Mirrors RepoShape in src/fetchers/repo-shape.ts.
export const repoShapeSchema = z.enum([
  "library",
  "framework",
  "app",
  "template",
  "tutorial",
  "aggregator",
  "unknown",
]);

/** Byte-capped opaque raw payload (candidates.raw_json). Rejects circular
 * structures and anything that serialises past the cap. */
export const rawPayloadSchema = z.unknown().superRefine((v, ctx) => {
  if (v === undefined || v === null) return;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "raw payload is not JSON-serialisable" });
    return;
  }
  if (serialized !== undefined && utf8Bytes(serialized) > LIMITS.RAW_JSON_MAX_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `raw payload exceeds ${LIMITS.RAW_JSON_MAX_BYTES} bytes`,
    });
  }
});

/**
 * The barrier every fetched candidate crosses before touching the candidates
 * table / embedding pass. Shape mirrors FetchedCandidate (src/fetchers/types.ts).
 */
export const fetchedCandidateSchema = z.strictObject({
  source: safeString(LIMITS.SOURCE_MAX, { min: 1, pattern: /^[a-z0-9][a-z0-9:._-]*$/i }),
  sourceItemId: scrapedScalar(LIMITS.SOURCE_ITEM_ID_MAX, { min: 1 }),
  title: scrapedScalar(LIMITS.TITLE_MAX, { min: 1 }),
  url: safeUrl(LIMITS.URL_MAX),
  githubUrl: githubUrlSchema().nullable(),
  author: scrapedScalar(LIMITS.AUTHOR_MAX).nullable(),
  score: z.number().int().min(LIMITS.SCORE_MIN).max(LIMITS.SCORE_MAX).nullable(),
  postedAt: z
    .date()
    .nullable()
    .superRefine((d, ctx) => {
      if (d === null) return;
      const t = d.getTime();
      if (!Number.isFinite(t)) {
        ctx.addIssue({ code: "custom", message: "invalid Date" });
        return;
      }
      if (t < Date.UTC(1995, 0, 1) || t > Date.now() + 7 * 24 * 3600 * 1000) {
        ctx.addIssue({ code: "custom", message: "postedAt outside plausible range" });
      }
    }),
  raw: rawPayloadSchema,
  primaryLanguage: scrapedScalar(LIMITS.LANGUAGE_MAX).nullable().optional(),
  topics: safeArray(scrapedScalar(LIMITS.TOPIC_MAX, { min: 1 }), LIMITS.TOPICS_MAX)
    .nullable()
    .optional(),
  repoShape: repoShapeSchema.nullable().optional(),
});

/** Hard-failing batch barrier: a fetcher returning more than BATCH_MAX items
 * is itself suspect (compromised source / amplification). */
export const fetchedCandidateBatchSchema = safeArray(fetchedCandidateSchema, LIMITS.BATCH_MAX);

/** Scraped prose that rides along with candidates (readmeHead on the
 * enrichment pass / catalogue) — prose profile. */
export const readmeHeadSchema = scrapedProse(LIMITS.README_HEAD_MAX);

export type GuardedBatchResult = {
  accepted: FetchedCandidate[];
  rejected: { index: number; reasons: string[] }[];
};

/**
 * Pipeline-friendly wrapper: validates each item, drops+reports bad ones
 * instead of failing the whole fetch (one poisoned scraped item must not
 * block the run — same ethos as the per-fetcher timeout). Anything past
 * BATCH_MAX is rejected wholesale as overflow.
 */
export function guardFetchedBatch(items: unknown): GuardedBatchResult {
  const accepted: FetchedCandidate[] = [];
  const rejected: { index: number; reasons: string[] }[] = [];
  if (!Array.isArray(items)) {
    return { accepted, rejected: [{ index: -1, reasons: ["batch is not an array"] }] };
  }
  items.forEach((item, index) => {
    if (index >= LIMITS.BATCH_MAX) {
      rejected.push({ index, reasons: [`batch overflow: item ${index} past cap ${LIMITS.BATCH_MAX}`] });
      return;
    }
    const res = fetchedCandidateSchema.safeParse(item);
    if (!res.success) {
      rejected.push({
        index,
        reasons: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      });
      return;
    }
    const c = res.data;
    // Explicit mapping = compile-time proof the barrier output is assignable
    // to the real FetchedCandidate the pipeline consumes.
    const out: FetchedCandidate = {
      source: c.source,
      sourceItemId: c.sourceItemId,
      title: c.title,
      url: c.url,
      githubUrl: c.githubUrl,
      author: c.author,
      score: c.score,
      postedAt: c.postedAt,
      raw: c.raw ?? null,
      primaryLanguage: c.primaryLanguage ?? null,
      topics: c.topics ?? null,
      repoShape: c.repoShape ?? null,
    };
    accepted.push(out);
  });
  return { accepted, rejected };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. API border — /api/ingest and /api/triage bodies
 * ────────────────────────────────────────────────────────────────────────── */

/** POST /api/ingest body. strictObject: unknown keys are rejected. */
export const ingestBodySchema = z.strictObject({
  url: safeUrl(LIMITS.URL_MAX),
  title: scrapedScalar(LIMITS.INGEST_TITLE_MAX).optional(),
  note: scrapedProse(LIMITS.INGEST_NOTE_MAX).optional(),
});

// Vocabulary mirrors src/app/api/triage/route.ts VALID_* constants.
export const VERDICTS = ["adopt", "port", "cherry-pick", "clean-room", "upgrade", "skip", "defer"] as const;
export const EFFORT_BANDS = ["quick", "moderate", "deep"] as const;
export const REASON_CODES = [
  "fit",
  "modality-collision",
  "task-collision",
  "covered",
  "wrong-posture",
  "low-quality",
  "other",
] as const;

// Ecosystem-optionally-prefixed package name ("react", "@libsql/client",
// "npm:moment", "cargo:serde").
export const DEP_NAME_RE =
  /^(?:[a-z][a-z0-9]{1,15}:)?(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;
export const depNameSchema = safeString(LIMITS.DEP_NAME_MAX, { min: 1, pattern: DEP_NAME_RE });

/** POST /api/triage body. */
export const triageBodySchema = z
  .strictObject({
    repo: githubRepoRef.optional(),
    repoId: z.number().int().positive().max(INT32_MAX).optional(),
    project: safeString(LIMITS.PROJECT_SLUG_MAX, { min: 1 }).nullable().optional(),
    projectId: z.number().int().positive().max(INT32_MAX).nullable().optional(),
    verdict: z.enum(VERDICTS),
    score: z.number().min(0).max(100).optional(),
    effortBand: z.enum(EFFORT_BANDS).optional(),
    oneLine: scrapedProse(LIMITS.ONELINE_MAX).optional(),
    writeup: scrapedProse(LIMITS.WRITEUP_MAX_CHARS)
      .refine(maxBytes(LIMITS.WRITEUP_MAX_BYTES), {
        message: `writeup exceeds ${LIMITS.WRITEUP_MAX_BYTES} bytes`,
      })
      .optional(),
    sessionId: safeString(LIMITS.SESSION_ID_MAX, { min: 1, pattern: /^[A-Za-z0-9._:-]+$/ }).optional(),
    matchedFacet: scrapedScalar(LIMITS.FACET_MAX).optional(),
    facetModality: safeString(LIMITS.FACET_MAX).optional(),
    reasonCode: z.enum(REASON_CODES).optional(),
    cosine: z.number().min(-1).max(1).optional(),
    depsConfirmed: safeArray(depNameSchema, LIMITS.DEPS_LIST_MAX).optional(),
    depsSuperseded: safeArray(depNameSchema, LIMITS.DEPS_LIST_MAX).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.repo === undefined && body.repoId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "must specify repoId (number) or repo ('owner/name')",
      });
    }
  });

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. CLI / MCP border — registration, capability reports, dep versions
 * ────────────────────────────────────────────────────────────────────────── */

export const modalityTag = safeString(LIMITS.CAP_MODALITY_MAX, {
  min: 1,
  pattern: /^[a-z0-9][a-z0-9-]*$/,
});

export const capabilityEntrySchema = z.union([
  scrapedScalar(LIMITS.CAP_TAG_MAX, { min: 1 }),
  z.strictObject({
    tag: scrapedScalar(LIMITS.CAP_TAG_MAX, { min: 1 }),
    descriptor: scrapedProse(LIMITS.CAP_DESCRIPTOR_MAX).optional(),
    modality: safeArray(modalityTag, LIMITS.CAP_MODALITY_ITEMS_MAX).optional(),
    paths: safeArray(repoRelativePath, LIMITS.CAP_PATHS_MAX).optional(),
  }),
]);

/** Capability report posted by replen_set_capabilities / the onboarding
 * skill (caps mirror mcp/src/server.ts). */
export const capabilityReportSchema = z
  .strictObject({
    repo: githubRepoRef.optional(),
    repoId: z.number().int().positive().max(INT32_MAX).optional(),
    report: scrapedProse(LIMITS.REPORT_MAX_CHARS)
      .refine(maxBytes(LIMITS.REPORT_MAX_BYTES), {
        message: `report exceeds ${LIMITS.REPORT_MAX_BYTES} bytes`,
      })
      .optional(),
    purpose: scrapedProse(LIMITS.PURPOSE_MAX).optional(),
    goals: safeArray(scrapedScalar(LIMITS.GOAL_MAX, { min: 1 }), LIMITS.GOALS_MAX).optional(),
    capabilities: safeArray(capabilityEntrySchema, LIMITS.CAPABILITIES_MAX).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.repo === undefined && body.repoId === undefined) {
      ctx.addIssue({ code: "custom", message: "must specify repoId (number) or repo ('owner/name')" });
    }
  });

/** Dep-version report (project_profiles.dep_versions): Record<depName, version>. */
export const depVersionsSchema = boundedRecord({
  keyMax: LIMITS.DEP_NAME_MAX,
  keyPattern: DEP_NAME_RE,
  maxKeys: LIMITS.DEP_RECORD_MAX_KEYS,
  value: safeString(LIMITS.DEP_VERSION_MAX, {
    min: 1,
    pattern: /^[A-Za-z0-9^~><=.+*, _-]{1,64}$/,
  }),
});

/** Immersion vectors-only transmit path: a text-embedding-3-small vector.
 * Length pinned to 1536; every component finite and magnitude-bounded so a
 * poisoned vector can't NaN/Inf-poison cosine ranking. */
export const embeddingVectorSchema = z
  .array(z.number().finite().gte(-8).lte(8))
  .length(LIMITS.EMBEDDING_DIM);

/* ────────────────────────────────────────────────────────────────────────── *
 * Inferred types
 * ────────────────────────────────────────────────────────────────────────── */

export type GuardedFetchedCandidate = z.infer<typeof fetchedCandidateSchema>;
export type IngestBody = z.infer<typeof ingestBodySchema>;
export type TriageBody = z.infer<typeof triageBodySchema>;
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;
export type DepVersions = z.infer<typeof depVersionsSchema>;
