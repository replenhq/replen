// Pipeline v2 / Sprint 2 — eligibility filter.
//
// Stage 2 of the four-stage pipeline (see docs/pipeline-v2.md). Sits
// between Stage 1 (Inventory — `candidates` table populated by fetchers)
// and Stage 3 (Scoring — `reason.ts` / `score-targeted.ts` LLM calls).
//
// Goal: KILL obvious mismatches cheaply, before any LLM token gets spent.
// Every rule here is deterministic — same input → same verdict, no LLM
// calls, no per-user state changes. Cheap to run, easy to debug, safe to
// regression-test.
//
// What this DOESN'T do:
//   - Soft relevance scoring (Stage 3, expensive LLM).
//   - Cross-match consistency (separate pass — see crossMatchConsistency
//     export at the bottom).
//   - Per-project language inference (Sprint 3+). Today we use the user's
//     detected_languages (broad signal) as the project's language family.

import type { RepoShape } from "../fetchers/repo-shape";

// What we need from a candidate row to apply the rules. Matches the
// candidates table shape; nullable fields are tolerated (Stage 1 tags
// when it has the data, leaves null otherwise).
export type EligibilityInput = {
  primaryLanguage: string | null;
  repoShape: RepoShape | null;
  postedAt: Date | null;     // candidate's created/pushed date as fetched
  score: number | null;       // star count (or proxy)
  source: string;             // for tracing rules to specific fetchers
};

export type EligibilityContext = {
  // CSV from user_settings.detectedLanguages. Empty/null means "no
  // language signal" — we degrade gracefully by not enforcing the
  // language-family rule rather than refusing every candidate.
  detectedLanguages: string | null;
};

export type EligibilityVerdict =
  | { eligible: true; forceApproach?: never; reason?: never }
  | { eligible: false; reason: string; forceApproach?: never }
  // The "downgrade" verdict: candidate IS eligible but only at the
  // cleanroom-rebuild ambition. Stage 3 then knows the LLM should pick
  // that approach rather than e.g. "depend-on-it" or "cherry-pick".
  | { eligible: true; forceApproach: "cleanroom-rebuild"; reason: string };

const FRESHNESS_FLOOR_DAYS = 30;
const FRESHNESS_FLOOR_STARS = 50;

// "TypeScript" and "JavaScript" are runtime-compatible — TS compiles to
// JS, JS can be imported into TS projects, and most popular JS libs ship
// TS types. Treat them as a single family. Other equivalences:
//   - "C++" / "C" — common shared codebases
//   - "JavaScript" / "TypeScript" — runtime-equivalent
// Languages NOT in any family stand alone. Lowercase comparison.
const LANGUAGE_FAMILY: Record<string, string> = {
  typescript: "ts-js",
  javascript: "ts-js",
  jsx: "ts-js",
  tsx: "ts-js",
  c: "c",
  "c++": "c",
};

function familyOf(lang: string | null | undefined): string {
  if (!lang) return "";
  const k = lang.trim().toLowerCase();
  return LANGUAGE_FAMILY[k] ?? k;
}

/** Check if a candidate is eligible to reach the scoring stage.
 *  Order of rules matters — drop reasons are reported in priority order
 *  so the streamer line is the most-informative cause.
 */
export function checkEligibility(
  c: EligibilityInput,
  ctx: EligibilityContext,
): EligibilityVerdict {
  const shape = c.repoShape ?? "unknown";

  // 1. Aggregator (Composio-class). These compete with the user's product
  //    rather than integrate into it — "use this instead of building."
  //    Out-of-scope for Replen's value prop in all cases we can think of;
  //    drop outright. If a user genuinely wants to build ON TOP of one of
  //    these, they can /api/ingest the URL manually.
  if (shape === "aggregator") {
    return { eligible: false, reason: "aggregator (platform / awesome-list / SDK suite)" };
  }

  // 2. Tutorial / template — not libraries, not for integration.
  if (shape === "tutorial") {
    return { eligible: false, reason: "tutorial / learning material" };
  }
  if (shape === "template") {
    return { eligible: false, reason: "starter template / boilerplate" };
  }

  // 3. Freshness floor — < 30 days old AND < 50 stars. Combined: too
  //    fresh to grade, too few stars to vouch for itself. Either alone is
  //    fine — a 60-day-old project with 20 stars is "small but real," a
  //    20-day-old project with 200 stars is "spike but real". Both red
  //    flags together is when we drop.
  if (c.postedAt && (c.score ?? 0) < FRESHNESS_FLOOR_STARS) {
    const ageDays = (Date.now() - c.postedAt.getTime()) / (24 * 3600 * 1000);
    if (ageDays < FRESHNESS_FLOOR_DAYS) {
      return { eligible: false, reason: `too fresh (${Math.round(ageDays)}d old, <${FRESHNESS_FLOOR_STARS}★)` };
    }
  }

  // 4. Language-family mismatch — only fires when we have BOTH a
  //    candidate language AND user detected languages. Coarse: uses the
  //    user-level detected languages as the project's language family,
  //    not per-project. Per-project language inference is Sprint 3+.
  //    When mismatch + the candidate is shaped like a library, the LLM
  //    can't credibly score this as "depend-on-it" or "cherry-pick".
  //    Force `cleanroom-rebuild` — the IDEA can transfer, the code can't.
  const detected = (ctx.detectedLanguages ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (c.primaryLanguage && detected.length > 0 && shape === "library") {
    const candFamily = familyOf(c.primaryLanguage);
    const projectFamilies = new Set(detected.map((l) => familyOf(l)));
    if (candFamily && !projectFamilies.has(candFamily)) {
      return {
        eligible: true,
        forceApproach: "cleanroom-rebuild",
        reason: `language mismatch (${c.primaryLanguage} vs ${detected.slice(0, 3).join("/")}) → idea-only`,
      };
    }
  }

  // 5. App / framework / unknown shapes pass through. App + framework
  //    are valid suggestions (use Next.js, deploy n8n, etc.); unknown
  //    defers to the LLM tier rather than blocking on ambiguity.
  return { eligible: true };
}

// Helper for the orchestrator to summarise drops by reason for the
// streamer log. Stable input order → stable output, so the same run
// produces the same summary.
export function summariseDrops(drops: Array<{ reason: string }>): string[] {
  const byReason = new Map<string, number>();
  for (const d of drops) {
    byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  }
  return [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count}× ${reason}`);
}

// -- Cross-match consistency ------------------------------------------
//
// Separate from per-candidate eligibility. Runs AFTER all matches have
// been generated for a run. Detects the "drop X / replace Y with X"
// contradiction we saw on tech-news-site (fluent-ffmpeg flagged for
// drop while @ffmpeg-installer/ffmpeg was being replaced WITH
// fluent-ffmpeg).
//
// Input shape is what the prune analyzer + scoring layer already emit;
// no schema additions needed. The orchestrator (run-once.ts) calls
// this with the final match set before persist.

export type PruneVerdict = {
  matchId: number;
  /** "drop" or "replace" */
  action: "drop" | "replace" | "keep";
  /** Package the prune is about — the thing this match recommends removing/replacing. */
  prunedDepName: string;
  /** When action == "replace", the suggested replacement. */
  replacementName: string | null;
  /** The score this match landed at — used to pick the winner when two contradict. */
  relevanceScore: number;
};

export type CrossMatchConflict = {
  loserMatchId: number;
  reason: string;
};

/** Detect prune matches that contradict each other. A "drop X" recommendation
 *  is incompatible with a "replace Y with X" recommendation in the same run.
 *  Returns the matchIds we should drop, with reasons.
 */
export function detectPruneConflicts(prunes: PruneVerdict[]): CrossMatchConflict[] {
  const conflicts: CrossMatchConflict[] = [];
  const dropping = new Map<string, PruneVerdict>(); // pkg → match that wants to drop it
  const replacingWith = new Map<string, PruneVerdict[]>(); // replacement-pkg → matches suggesting it
  for (const p of prunes) {
    if (p.action === "drop") {
      const key = p.prunedDepName.toLowerCase();
      const existing = dropping.get(key);
      if (!existing || p.relevanceScore > existing.relevanceScore) dropping.set(key, p);
    } else if (p.action === "replace" && p.replacementName) {
      const key = p.replacementName.toLowerCase();
      const list = replacingWith.get(key) ?? [];
      list.push(p);
      replacingWith.set(key, list);
    }
  }
  for (const [pkg, dropMatch] of dropping) {
    const replacers = replacingWith.get(pkg);
    if (!replacers || replacers.length === 0) continue;
    // Contradiction. Keep the higher-scored side; drop the other.
    for (const r of replacers) {
      if (dropMatch.relevanceScore >= r.relevanceScore) {
        conflicts.push({
          loserMatchId: r.matchId,
          reason: `contradicts match #${dropMatch.matchId} which flags ${pkg} as dead (drop)`,
        });
      } else {
        conflicts.push({
          loserMatchId: dropMatch.matchId,
          reason: `contradicts match #${r.matchId} which suggests ${pkg} as a maintained replacement`,
        });
      }
    }
  }
  return conflicts;
}
