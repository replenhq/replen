// Phase 3 — raw sectioned-doc matching. Slice a project's README / CLAUDE.md
// into sections by heading and turn each substantive section into a facet
// (label = heading, embed text = heading + body). This matches against the
// docs the user actually WROTE — lossless — instead of the LLM summary's lossy
// paraphrase. A section describing "we fuse drone telemetry with a Kalman
// filter" surfaces a Kalman library even if the capability extractor never
// emitted "sensor fusion" as a tag.
//
// Section facets sit alongside the clean capability facets in
// project_profiles.facet_embeddings; the matcher already scores on the best
// facet, so they only add recall. Boilerplate sections (install, license,
// contributing…) are dropped — they carry no capability signal and would make
// noisy probes.

export type DocSection = { label: string; text: string };

const MAX_SECTIONS = Math.max(1, parseInt(process.env.REPLEN_DOC_MAX_SECTIONS ?? "8", 10) || 8);
// Sections shorter than this (body, post-trim) are headings with no real
// content — skip rather than embed a near-empty probe.
const MIN_BODY_CHARS = 40;
// Per-section embed-text cap (OpenAI input limit is ~8k chars).
const MAX_SECTION_CHARS = 7000;

// Headings that are scaffolding / meta, not capability signal. Matched
// case-insensitively against the (cleaned) heading; a leading-word match is
// enough. Includes structural headings (repo layout, status, tags) that embed
// file paths or meta rather than capabilities.
const BOILERPLATE = /^(install\b|installation|usage|how to use|getting started|quick ?start|setup|set up|prerequisites?|requirements?|licen[sc]e|contributing|contribution|table of contents|contents|development|developing|testing|tests?|deployment|deploy(ing)?|building|build\b|ci\/cd|^ci$|faq|frequently asked|change ?log|roadmap|acknowledge?ments?|credits|authors?|maintainers?|contact|support|getting help|sponsors?|donate|funding|stars?|badges?|disclaimer|warranty|security policy|code of conduct|repo layout|repository layout|project structure|directory structure|file structure|folder structure|layout|status|replen tags|tags|overview|introduction|intro\b|about\b|summary|features?|configuration|config\b|commands?|environments?|env\b|stack\b|tech stack|active areas?|niche|domain|constraints?|non.?goals?|anti.?patterns?|integration preferences?|what it is|how it works|architecture|notes?|todo|option \d|step \d)/i;

// Headings that carry NEGATIVE signal — what the project deliberately does NOT
// do. Embedding these as positive probes would surface exactly what the user
// rejected, so they're dropped entirely.
const NEGATIVE = /(not in scope|out of scope|non.?goals?|what'?s not|anti.?patterns?|don'?t|do not|avoid|won'?t|limitations?|known issues?|caveats?|gotchas?|deprecated|exclusions?)/i;

// Headings about AI-tooling / assistant config — that's HOW you develop, not
// what the project DOES. CLAUDE.md / AGENTS.md sections about these would
// otherwise become "Claude Code Configuration"-style noise facets that match
// dev-tooling repos for unrelated projects.
const META_TOOLING = /(claude code|claude\b|\bmcp\b|model context protocol|cursor|copilot|\bagents?\b|subagents?|\bhooks?\b|slash commands?|\breplen\b|ai assistant|coding assistant|gemini|codex|\bllm instructions?\b)/i;

// Structural / non-capability headings that aren't boilerplate-by-name but
// carry no capability signal: video-script cues ("02-context — 0:18"),
// numbered-section slugs ("01-open"), narration/teleprompter docs, or labels
// with no real words (codes/slugs). These slipped past BOILERPLATE because the
// heading text is arbitrary — they're caught structurally instead. Exported so
// the matcher can ALSO drop them defensively at read time (legacy facets stored
// before this filter existed), not just at generation.
const NARRATION_NOISE = /(teleprompter|narration|voice-?over|screencast|b-?roll|storyboard|walkthrough script|demo script)/i;
// Doc-section headings that are pure framing, not a capability: "Why", "What
// this project is", "Sibling tooling", "Motivation". They became facets only
// because they're headings; as probes they're noise (a "Why" facet matches
// nothing meaningful). Dropped ENTIRELY (not just as probes) — there's no
// coverage value in a framing heading. Anchored to the whole label so a real
// capability that merely contains a word ("rationale engine") survives.
const STRUCTURAL_HEADING = /^((project |system |architecture |code |repo |high.?level )?overview|why|why this( matters| project| works)?|what|what['’]s this|what is this|what this( project)?( is| does| means)?|what it( is| does)|what we (do|built)|how( it| this)? works|data flow|control flow|data model|sibling (tooling|projects?|repos?)|related (tooling|projects?|work)|motivation|background|context|rationale|goals?|objectives?|purpose|next steps?|what['’]s next|the (problem|solution)|problem statement|tl;?dr)$/i;
export function isNoiseFacetLabel(label: string): boolean {
  const l = label.trim();
  if (!l) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(l)) return true;           // timestamp cue (0:18) — video/teleprompter
  if (/^\d{1,3}\s*[-.)]/.test(l)) return true;            // numbered-section prefix (01-, 2., 3))
  if ((l.match(/[a-z]/gi) ?? []).length < 3) return true; // codes/slugs with no real words
  if (NARRATION_NOISE.test(l)) return true;               // video/script meta doc
  if (STRUCTURAL_HEADING.test(l)) return true;            // framing heading, not a capability
  if (/^q[1-4]\b/i.test(l)) return true;                  // roadmap quarter heading ("Q2 — …")
  if (/\b[A-Za-z]{2,5}\d+\.[a-z]/.test(l)) return true;   // ticket/milestone code ("ML21.b.2")
  if ((l.match(/\b[A-Z][a-z]+[A-Z][a-z]+\b/g) ?? []).length >= 2) return true; // ≥2 CamelCase code identifiers ("EnemyPosition / OsintObservation") — a doc/code dump, not a capability
  if (/\(\d+[^)]*\)\s*$/.test(l)) return true;            // trailing tally — "Case Studies (5 pages)", "Pages to Delete (1)"
  if (/\b(pages?|posts?|articles?)\s+(to|at|already)\b/i.test(l)) return true; // content-audit/TODO headings
  if (/\b(to delete|to create|to remove|already present|wrong url|needs? (relocation|review|update))\b/i.test(l)) return true;
  return false;
}

// Generic infrastructure plumbing that nearly EVERY project has — storage
// buckets, containers, CI, deploy tooling. As match PROBES these are
// promiscuous: "AWS S3" sits near half of GitHub, which is how a JS
// serverless-deploy framework got shortlisted for a Python GPU-serving repo
// ("adjacent to your AWS S3"). They stay valid as capabilities (coverage,
// graph nodes, "already have" exclusion) — they just can't LEAD a match or
// seed adjacency. Conservative on purpose: real capability domains that
// merely involve infra ("geospatial data storage") must not match, so the
// pattern is anchored to the whole label, with only generic suffixes allowed.
const INFRA_CORE =
  "(aws s3|amazon s3|s3|object storage|blob storage|file uploads?|file storage|" +
  "docker( compose)?|dockerfile|containeri[sz]ation|kubernetes|k8s|helm|" +
  "ci ?/? ?cd|continuous (integration|delivery|deployment)|github actions|gitlab ci|" +
  "terraform|infrastructure as code|deployment|devops|cloud infrastructure|" +
  "nginx|reverse proxy|load balancing|environment variables?|configuration|secrets management)";
const GENERIC_INFRA_RE = new RegExp(
  `^${INFRA_CORE}( (integration|support|setup|config(uration)?|storage|hosting|pipeline|workflows?|deployment|management|automation))?$`,
  "i",
);
export function isGenericInfraFacetLabel(label: string): boolean {
  const l = label.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return GENERIC_INFRA_RE.test(l);
}

// Generic-but-real capability words too vague to LEAD a match: a bare
// "optimization" sits near every optimizer (a macOS disk cleaner matched a
// trading bot on it); "core components" / "core" / "components" are structural;
// "database"/"postgresql" sit near every DB tool. Like infra, these stay valid
// capabilities (coverage, graph, already-have) but can't lead a match, seed
// adjacency, or pull catalogue. Anchored whole-label + optional generic suffix,
// so a real domain ("query optimization", "geospatial database") is NOT caught.
const GENERIC_CAP_CORE =
  "(core|core components?|components?|modules?|utilit(y|ies)|helpers?|" +
  "optim(i[sz]ation|i[sz]er)|performance|scalability|reliability|" +
  "database|databases|data ?store|persistence|postgres(ql)?|mysql|sqlite|mongodb|" +
  "caching|cache|logging|monitoring|observability|telemetry|metrics|" +
  "api|apis|rest api|backend|frontend|full ?stack|web app|application|library|framework|" +
  "scanner|scanning|scanner testing|testing|automation|tooling|integration|general)";
const GENERIC_CAP_RE = new RegExp(
  `^${GENERIC_CAP_CORE}( (support|integration|layer|module|system|engine|service|pipeline|management))?$`,
  "i",
);
// The single check the route uses: a facet too generic to be a useful probe,
// whether it's infrastructure plumbing or a vague capability word.
export function isGenericProbeFacetLabel(label: string): boolean {
  const l = label.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return GENERIC_INFRA_RE.test(l) || GENERIC_CAP_RE.test(l);
}

type RawSection = { heading: string; body: string };

function parseMarkdownSections(md: string): RawSection[] {
  const lines = md.split(/\r?\n/);
  const out: RawSection[] = [];
  let heading = "";
  let body: string[] = [];
  let inFence = false;
  const flush = () => {
    const b = body.join("\n").trim();
    if (heading || b) out.push({ heading, body: b });
  };
  for (const line of lines) {
    // Don't treat '#' inside fenced code blocks as headings.
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (m) {
      flush();
      heading = m[2].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

// Strip markdown noise from a heading so it reads as a clean facet label.
function cleanHeading(h: string): string {
  return h
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/[*_~]/g, "")
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "") // leading emoji
    .replace(/:\s*$/, "")
    .trim()
    .slice(0, 60);
}

const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

function sectionsFromDoc(md: string | null, preambleLabel: string, dropNames: Set<string>): DocSection[] {
  if (!md || !md.trim()) return [];
  const out: DocSection[] = [];
  for (const raw of parseMarkdownSections(md)) {
    const label = raw.heading ? cleanHeading(raw.heading) : preambleLabel;
    if (!label) continue;
    // The H1 title is usually the project name + a description blob — it behaves
    // like a mini-centroid and matches loosely. Drop it (the real centroid
    // already covers the whole project).
    if (dropNames.has(norm(label))) continue;
    if (isNoiseFacetLabel(label)) continue;
    if (BOILERPLATE.test(label) || NEGATIVE.test(label) || META_TOOLING.test(label)) continue;
    const body = raw.body.trim();
    if (body.length < MIN_BODY_CHARS) continue;
    // Drop sections dominated by AI-tooling/assistant config even when the
    // heading is innocuous (a CLAUDE.md block of Claude Code instructions).
    const metaHits = (body.match(META_TOOLING) ? (body.match(new RegExp(META_TOOLING, "gi"))?.length ?? 0) : 0);
    if (metaHits >= 3) continue;
    const text = `${label}. ${body}`.slice(0, MAX_SECTION_CHARS);
    out.push({ label, text });
  }
  return out;
}

/**
 * Extract substantive doc sections as facets. CLAUDE.md first (it's the
 * Replen-optimised doc — richer signal), then README. Deduped by label
 * (case-insensitive, first-seen wins) and capped. Preamble (text before the
 * first heading — usually the project description) is kept as "Overview".
 */
export function extractDocSections(readmeMd: string | null, claudeMd: string | null, projectName?: string | null, projectSlug?: string | null): DocSection[] {
  // Labels matching the project's own name/slug are the title blob — drop them.
  // BOTH name and slug: the human name ("acme Command Intelligence") and the
  // slug/H1 ("acme-web") often differ, and the README H1 is usually the slug.
  const dropNames = new Set<string>();
  for (const raw of [projectName, projectSlug]) {
    if (!raw) continue;
    const n = norm(raw);
    if (!n) continue;
    dropNames.add(n);
    // also without a trailing role suffix (acme-web → acme)
    dropNames.add(n.replace(/\s+(web|app|api|ui|frontend|backend|server|client|cli|core|service|mobile|cv|edge|infra|engine)$/i, "").trim());
  }
  const all = [
    ...sectionsFromDoc(claudeMd, "Overview", dropNames),
    ...sectionsFromDoc(readmeMd, "Overview", dropNames),
  ];
  const seen = new Set<string>();
  const out: DocSection[] = [];
  for (const s of all) {
    const key = s.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}
