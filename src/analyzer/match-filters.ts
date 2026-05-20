// Post-LLM match filters. Run AFTER the reasoner produces a per-project
// verdict, BEFORE inserting into the matches table. The reasoner
// sometimes produces verdicts that are technically scored "matches"
// but really just hand research back to the user ("worth studying",
// "could inspire"). Surfacing those is anti-value — the whole point
// of Replen is "Replen does the research".
//
// Two filters:
//
// 1. researchHandoff(text) — true when the LLM's writeup admits it
//    couldn't find an actionable integration and is instead saying
//    "study X for inspiration". Drop the match entirely.
//
// 2. unanchoredRebuild(approach, projectId) — true when integration
//    approach is "cleanroom-rebuild" AND there's no specific user
//    project to rebuild against (i.e. it's a _general / no-project
//    match). The user's call: cleanroom-rebuild on YOUR OWN project
//    is useful ("rebuild this pattern in YOUR codebase"); cleanroom-
//    rebuild on _general is just "go build a thing someone built" —
//    no anchor, no action.

// Phrases the reasoner uses when it doesn't really have an actionable
// recommendation. Detected case-insensitively across the writeup +
// summary + whyUseful + suggestedUse fields. Conservative: each
// phrase must be specific enough that it rarely appears in a
// genuinely actionable match. Add to this list when you see a new
// pattern of research-handoff in the feed.
const RESEARCH_HANDOFF_PHRASES = [
  "worth studying",
  "worth a read",
  "for inspiration",
  "could inspire",
  "could inform",
  "study its approach",
  "study its design",
  "study the approach",
  "use as a reference",
  "use as inspiration",
  "consider studying",
  "consider reading",
  "you should research",
  "offers nothing new",
  "more work than writing custom",
  "more work than rebuilding",
  "not a drop-in",
  "not a direct plug-in",
  "not a direct fit",
  "no clear integration",
  "the value is conceptual",
  "the value is in the design",
];

export type FilterDecision =
  | { drop: false }
  | { drop: true; reason: string };

export function decideMatchFilter(input: {
  writeupMd?: string | null;
  summary?: string | null;
  whyUseful?: string | null;
  suggestedUse?: string | null;
  risks?: string | null;
  integrationApproach?: string | null;
  projectId?: number | null;
}): FilterDecision {
  // Filter 1: cleanroom-rebuild without a project anchor.
  if (
    (input.integrationApproach === "cleanroom-rebuild" || input.integrationApproach === "Rebuild in-house")
    && (input.projectId === null || input.projectId === undefined)
  ) {
    return { drop: true, reason: "cleanroom-rebuild without project anchor" };
  }

  // Filter 2: research-handoff phrases anywhere in the writeup or
  // structured fields. Concatenate everything user-visible.
  const haystack = [
    input.writeupMd ?? "",
    input.summary ?? "",
    input.whyUseful ?? "",
    input.suggestedUse ?? "",
    input.risks ?? "",
  ].join(" \n ").toLowerCase();
  for (const phrase of RESEARCH_HANDOFF_PHRASES) {
    if (haystack.includes(phrase)) {
      return { drop: true, reason: `research-handoff: "${phrase}"` };
    }
  }

  return { drop: false };
}
