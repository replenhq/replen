// Score-cap post-processor. Runs after the LLM scores a match and applies
// mechanical caps the LLM may have skipped despite prompt rules. The caps
// are CONDITIONAL on the integration approach because that's where the
// user's actual risk lives:
//
//   - depend-on-it / vendor (full adoption): license, language fit, alpha
//     status, and abandonment all matter — they directly impact whether
//     "yes, install this" is sound advice.
//   - cherry-pick: license matters (you're still copying code), but alpha
//     / dormant / language matter much less — you're lifting specific
//     pieces and adapting them.
//   - cleanroom-rebuild: nothing matters except whether the idea is good.
//     You can read a dead Kotlin repo for ideas to reimplement in TS.
//
// We also enforce a citation rule on score>=80: the writeup MUST name at
// least one concrete identifier (file path, function, CamelCase symbol)
// from the candidate's README. Articulate writeups that score high without
// citing anything specific are the classic gpt-4o-mini hallucination shape
// (confident prose, no grounding) — demoting them to mid-medium is safer
// than trusting the score.

import type { ProjectAssessment } from "./reason";

export type RepoFlags = {
  /** No license field, or license string suggests "no license"/"NOASSERTION". */
  noLicense: boolean;
  /** README/description contains alpha/beta/WIP signals. */
  alpha: boolean;
  /** <50 stars AND >180 days since last push — likely abandoned single-maintainer. */
  dormant: boolean;
  /** Writeup contains at least one backticked identifier that looks like a file path
   * or function name (i.e. evidence of grounding rather than hand-waving). */
  hasCitation: boolean;
};

type SafetyLike = {
  meta: { stars: number | null; license: string | null };
  daysSincePush: number;
  readmeMd: string;
};

const ALPHA_PATTERN =
  /\b(alpha(?:\s*release)?|beta\s*release|pre-?release|experimental|work[-\s]?in[-\s]?progress|early[-\s]stage|under\s+(?:heavy\s+|active\s+)?development|not\s+production[-\s]ready|do\s+not\s+use\s+in\s+production)\b/i;

const NO_LICENSE_PATTERN = /^(no\s*license|noassertion|none|null|unknown)$/i;

export function detectAlpha(readme: string, description?: string | null): boolean {
  const head = readme.slice(0, 4000); // alpha warnings live near the top, don't scan the whole README
  if (ALPHA_PATTERN.test(head)) return true;
  if (description && ALPHA_PATTERN.test(description)) return true;
  return false;
}

export function detectNoLicense(license: string | null): boolean {
  if (!license) return true;
  return NO_LICENSE_PATTERN.test(license.trim());
}

export function detectCitation(writeup: string): boolean {
  // Backticked tokens are the convention the prompts ask for. A "real"
  // citation looks like one of:
  //   `path/to/file.ts`       → contains slash or dot-extension
  //   `funcName()`            → has parens
  //   `services/Tunnel.kt`    → path-like
  //   `CamelCaseName`         → looks like a class/type
  //   `kebab-case-cmd`        → looks like a CLI command (has hyphen)
  //
  // Plain backticked English words (`alpha`, `documentation`) don't count
  // — those don't prove the writeup is grounded in the candidate's source.
  const backticked = [...writeup.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  return backticked.some((s) => {
    if (s.length < 2) return false;
    if (s.includes("/")) return true;
    if (/\.[A-Za-z]{1,5}$/.test(s)) return true; // file extension
    if (/\(\s*\)?/.test(s)) return true;          // function call
    if (/[a-z][A-Z]/.test(s)) return true;        // CamelCase / mixed case
    if (/-/.test(s) && s.length > 4) return true; // kebab-case CLI / module name
    return false;
  });
}

export function computeRepoFlags(safety: SafetyLike, writeup: string): RepoFlags {
  const stars = safety.meta.stars ?? 0;
  return {
    noLicense: detectNoLicense(safety.meta.license),
    alpha: detectAlpha(safety.readmeMd),
    dormant: stars < 50 && safety.daysSincePush > 180,
    hasCitation: detectCitation(writeup),
  };
}

export type ScoreCapResult = {
  /** Possibly-demoted score. */
  score: number;
  /** Possibly-demoted relevance (derived from score). */
  relevance: "high" | "medium" | "general-awareness";
  /** Human-readable demotion reasons (for logs / debugging — not user-facing). */
  demotions: string[];
};

export function applyScoreCap(args: {
  rawScore: number;
  rawRelevance: ProjectAssessment["relevance"];
  approach: ProjectAssessment["integrationApproach"];
  flags: RepoFlags;
}): ScoreCapResult {
  let cap = 100;
  const demotions: string[] = [];
  const push = (cause: string, c: number) => {
    if (c < cap) {
      cap = c;
      demotions.push(`${cause} → cap ${c}`);
    } else {
      // Already capped lower; still log the cause for visibility.
      demotions.push(`${cause} → would-cap ${c}`);
    }
  };

  // Citation rule applies to ALL approaches. A high score without grounding
  // is the gpt-4o-mini hallucination signature.
  if (args.rawScore >= 80 && !args.flags.hasCitation) {
    push("no-grounded-citation", 70);
  }

  // Approach-conditional risk caps.
  if (args.approach === "depend-on-it" || args.approach === "vendor") {
    if (args.flags.noLicense) push("no-license-on-full-adoption", 55);
    if (args.flags.alpha) push("alpha-on-full-adoption", 55);
    if (args.flags.dormant) push("dormant-on-full-adoption", 50);
  } else if (args.approach === "cherry-pick") {
    if (args.flags.noLicense) push("no-license-on-cherry-pick", 65);
    // alpha / dormant don't penalise cherry-pick — the code is what it is
    // at the moment you lift it; future maintenance isn't your problem.
  }
  // cleanroom-rebuild + n/a: no caps. Ideas transfer regardless of
  // license / language / alpha status / abandonment.

  const score = Math.min(args.rawScore, cap);
  const relevance =
    score >= 80 ? "high" : score >= 50 ? "medium" : "general-awareness";
  return { score, relevance, demotions };
}
