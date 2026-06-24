// `replen project-init` — prints a copy-pasteable prompt the user feeds to
// their AI coding tool (Claude Code, Codex, Cursor, Aider, whatever) so it
// can draft a CLAUDE.md tuned for replen's relevance scorer.
//
// The prompt deliberately points at the live template URL so changes to the
// template don't require shipping a new CLI version. We do not write any
// files ourselves — the AI tool does, locally, with full source access.

const PROMPT = `Read this repository and produce a CLAUDE.md at the root, optimised for replen (https://replen.dev) — the daily research tool that scores new OSS repos against this project.

Follow the template + section guidance at https://docs.replen.dev/project-docs.html. The seven sections are:

  ## What this project is
  ## Stack
  ## Niche / problem domain
  ## Active areas
  ## Constraints & non-goals
  ## Anti-patterns
  ## Integration preferences

Be specific. Use the project's actual domain vocabulary, not generic abstractions. Derive content from the source, the existing README, and the last 30 git commits — not boilerplate. If you can't verify a section from the code or git history, leave it short rather than making things up.

When you're done, print the draft in chat and ask me to confirm before writing the file. If a CLAUDE.md already exists, don't overwrite it without my explicit say-so.

Total length target: 200-500 words, bullet points over paragraphs.

Also append a short "## Replen integration" section with this exact guidance:

  At the start of every session, if the \`replen_match\` tool is
  available, call it once (no repo arg — it defaults to the cwd repo)
  before asking the user what to work on. Relay the USER-FACING MESSAGE
  block it returns VERBATIM if it's non-empty; if it's empty, say
  nothing — silence is the correct response, not "no new matches found".

This instruction is a fallback for AI tools that don't run Claude Code's SessionStart hooks (e.g. Codex, Cursor, Aider). For Claude Code users the hook calls \`replen check-new\` automatically and Claude Code injects the result into the opening context — but the CLAUDE.md guidance is durable across tools and survives hook misconfiguration.`;

export function runProjectInit() {
  console.log("");
  console.log("Copy the prompt below into your AI coding tool (Claude Code / Codex / Cursor / Aider).");
  console.log("It will read this repo and draft a CLAUDE.md tuned for replen.");
  console.log("");
  console.log("─".repeat(64));
  console.log(PROMPT);
  console.log("─".repeat(64));
  console.log("");
  console.log("If you have the replen-project-init skill installed in Claude Code,");
  console.log("you can also invoke it with: /replen-project-init");
  console.log("(install: copy skills/replen-project-init/ into ~/.claude/skills/)");
  console.log("");
}
