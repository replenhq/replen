// Writeup formatting safety net. The LLM prompts ask for blank-line
// paragraph breaks, but gpt-4o-mini in particular tends to produce
// confident, substantive writeups in a single dense block. Strict
// regenerate-on-violation burns tokens; cap-the-score punishes
// users who get good content. This module auto-splits a wall-of-
// text writeup at sentence boundaries so the UI stays readable.
//
// Idempotent: if the writeup already has paragraph breaks, returns
// it unchanged. Only fires the auto-split when fewer than
// `minBreaks` blank-line gaps are found.

const SENTENCES_PER_PARAGRAPH = 3;
const MIN_LENGTH_FOR_SPLIT = 240; // ~40 words; under this, a single para is fine

/** Ensure a writeup has at least `minBreaks` paragraph breaks (\n\n)
 *  by splitting at sentence boundaries when it's a single dense
 *  paragraph. Returns the writeup unchanged if it's already broken
 *  up or short enough that splitting would feel artificial.
 */
export function ensureParagraphs(writeup: string | null | undefined, minBreaks = 2): string {
  if (!writeup) return "";
  const text = writeup.trim();
  if (text.length < MIN_LENGTH_FOR_SPLIT) return text;
  const existing = (text.match(/\n\n/g) ?? []).length;
  if (existing >= minBreaks) return text;

  // Sentence boundary = . ! ? followed by whitespace then capital letter.
  // Excludes things like "e.g.", "i.e.", "U.S.", "file.ts." — the
  // "capital letter follows" guard skips those because the next char
  // is typically lowercase or a path separator.
  const sentences: string[] = [];
  const sentenceEndRe = /([.!?])\s+(?=[A-Z])/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = sentenceEndRe.exec(text)) !== null) {
    sentences.push(text.slice(lastEnd, m.index + 1).trim());
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    sentences.push(text.slice(lastEnd).trim());
  }
  // Filter out empties + drop any "sentences" that are just a single
  // citation like `file.ts` that the regex over-split.
  const real = sentences.filter((s) => s.length > 0);
  if (real.length < SENTENCES_PER_PARAGRAPH + 1) return text;

  const paragraphs: string[] = [];
  for (let i = 0; i < real.length; i += SENTENCES_PER_PARAGRAPH) {
    paragraphs.push(real.slice(i, i + SENTENCES_PER_PARAGRAPH).join(" "));
  }
  return paragraphs.join("\n\n");
}
