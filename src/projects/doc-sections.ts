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
const BOILERPLATE = /^(install\b|installation|usage|how to use|getting started|quick ?start|setup|set up|prerequisites?|requirements?|licen[sc]e|contributing|contribution|table of contents|contents|development|developing|testing|tests?|deployment|deploy(ing)?|building|build\b|ci\/cd|^ci$|faq|frequently asked|change ?log|roadmap|acknowledge?ments?|credits|authors?|maintainers?|contact|support|getting help|sponsors?|donate|funding|stars?|badges?|disclaimer|warranty|security policy|code of conduct|repo layout|repository layout|project structure|directory structure|file structure|folder structure|layout|status|replen tags|tags)/i;

// Headings that carry NEGATIVE signal — what the project deliberately does NOT
// do. Embedding these as positive probes would surface exactly what the user
// rejected, so they're dropped entirely.
const NEGATIVE = /(not in scope|out of scope|non.?goals?|what'?s not|anti.?patterns?|don'?t|do not|avoid|won'?t|limitations?|known issues?|caveats?|gotchas?|deprecated|exclusions?)/i;

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

function sectionsFromDoc(md: string | null, preambleLabel: string): DocSection[] {
  if (!md || !md.trim()) return [];
  const out: DocSection[] = [];
  for (const raw of parseMarkdownSections(md)) {
    const label = raw.heading ? cleanHeading(raw.heading) : preambleLabel;
    if (!label) continue;
    if (BOILERPLATE.test(label) || NEGATIVE.test(label)) continue;
    const body = raw.body.trim();
    if (body.length < MIN_BODY_CHARS) continue;
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
export function extractDocSections(readmeMd: string | null, claudeMd: string | null): DocSection[] {
  const all = [
    ...sectionsFromDoc(claudeMd, "Overview"),
    ...sectionsFromDoc(readmeMd, "Overview"),
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
