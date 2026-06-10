# CLAUDE.md

<!-- This file is read by Claude Code at session start to understand the project. Edit freely above this marker — the Replen integration section below is auto-managed. -->

## What it is
Replen is a **tool/library discovery service** for AI coding workflows. It maps each of a user's repos to its technical **capabilities** (computer vision, geospatial, market-making, etc.) and watches the OSS ecosystem for things that fit — a library that fills a capability, a new release in a dependency you use, a security advisory in your stack, a standard you implement changing, an upstream going dark. **The matching is the product:** every candidate is scored against *your* capabilities, not a generic trending list. The expensive reasoning (per-candidate verdict + writeup) runs *in the user's Claude Code / Codex session* on their subscription tokens — the server side does only mechanical, no-LLM ingestion + ranking, so there's no per-user LLM bill and source code never leaves the user's machine.

## Stack
TypeScript (ESM, Node ≥20) · Next.js 16 + React 19 (dashboard + API routes under `src/app/`) · Drizzle ORM over SQLite/libSQL (`@libsql/client`, schema + migrations in `src/db/`) · node-cron scheduler (`src/scheduler/cron.ts`, `run-once.ts`) · Firebase Auth (`next-firebase-auth-edge`) · Zod validation · cheerio (HTML scraping) · nodemailer (digest email). OpenAI `text-embedding-3-small` for semantic matching (`src/lib/embeddings.ts`); a cheap chat model only for catalogue classification (`src/catalogue/classify.ts`). Ships two sibling npm packages: `cli/` (the `npx replen` onboarding one-liner) and `mcp/` (`@replen/mcp`, a stdio MCP server exposing ~13 tools). A Claude Code skill lives in `skills/replen-match/`.

## Niche / domain
Developer-tooling / AI-agent infrastructure: capability-based OSS discovery, semantic retrieval, and agent-in-the-loop triage. Domain vocabulary that matters: capability facets, facet vs centroid embeddings, modality gate (image/timeseries/text/… cross-modal collision suppression), eligibility filter, discovered vs scouted pools, diversity cap, discovery mode (scouted/discovered/re-checked/prune), the five watch lenses (libraries / security / stack-releases / spec-changes / upstream-health), skill tier vs hosted tier, handoff PR, k-anonymity for the cross-user catalogue.

## Architecture (how the matching works)
- **Ingestion (server, mechanical, no LLM):** `src/fetchers/` — one module per source (`gh-trending`, `gh-search*`, `ossinsight-trending`, `hn`, `reddit`, `threads`, `tiktok`) plus the four watch lenses (`stack-watch/`, `spec-watch/`, `security-watch/`, `health-watch/`). `index.ts` splits them into **discovered** (broad, language/topic-based) vs **scouted** (per-project targeted GitHub search) pools, each fetcher hard-capped by `FETCHER_TIMEOUT_MS`.
- **Project profiles:** `src/projects/` — loads each repo's README/CLAUDE.md, summarizes into structured capabilities (`summarize.ts`), and builds **per-capability facet embeddings** (`facets.ts`) plus a project centroid embedding. Facets let a candidate match the project's strongest *single* capability instead of its blended centroid.
- **Matching/ranking:** `src/lib/embeddings.ts` (cosine over `text-embedding-3-small` vectors stored as JSON in SQLite) + the **modality gate** (`src/projects/modality.ts`) that deterministically suppresses cross-modal collisions (an image lib never matches a timeseries capability). The skill-tier inventory endpoint is `src/app/api/inventory/today/route.ts`.
- **Shared catalogue:** `src/catalogue/` — a cross-user, capability-indexed library catalogue, k-anonymity-gated so one user's proprietary capability term never becomes a shared GitHub search.
- **Pipeline orchestration:** `src/scheduler/run-once.ts` runs the per-user phases (load profiles → discovered pool → per-project summaries/vectors/activity → embeddings → catalogue warm → scouted pool). **Skill tier stops at the candidate inventory**; hosted tier continues to the LLM analyzer + digest.
- **Delivery:** `mcp/` (the MCP tools), `skills/replen-match/` (the in-session triage playbook), the Next.js dashboard (`src/app/`), and an optional handoff-PR mechanism.

## Constraints / non-goals
- **No server-side per-candidate LLM reasoning.** The whole cost model depends on triage running in the user's AI session on their subscription tokens. Don't move verdict/writeup generation server-side. The only server LLM calls are cheap embeddings + the catalogue classifier.
- **Source code never leaves the user's machine.** The server sees repo identity, user-curated tags, and aggregate signal only — never the user's code.
- **Silence beats a weak match** — target cadence is 1-3 actionable matches per *month* per project; eligibility filters + the per-project diversity cap exist to protect that.
- Lean process: SQLite (no vector DB — cosine over hundreds of candidates is microseconds in JS), node-cron (no heavy queue/orchestration framework).
- **Capability privacy / k-anonymity** on the cross-user catalogue is load-bearing — a capability only becomes shared/searched if it's a seed term or ≥K distinct users have it.

## Anti-patterns (don't do)
- Don't reintroduce bag-of-tags intersection as the primary matcher — it produced the high-star-generic-repo firehose the embeddings + modality gate were built to kill.
- Don't make the modality gate fire on `unknown` ([]) modality — unknown means "don't gate", so a warming catalogue never over-suppresses.
- Don't add user-side LLM/API-key requirements — the skill tier's entire pitch is "no API key".
- Don't leak user project vocabulary into the cross-user catalogue tables (no user_id, no repo names, no code).
- Don't let one slow/hung fetcher block the pipeline — keep the per-fetcher timeout fallback.

## Open-core engineering rules
- **The engine is fully self-hostable, always.** No hosted-only code paths in matching, watching, or the graph. A single-user install runs the identical code; never add feature flags or crippleware to differentiate tiers.
- **Cross-user features must degrade gracefully to single-user.** k-thresholds and aggregate signals simply stay silent when there's one user. Any new cross-user feature must follow this pattern (see repo-quality, modality suppression, endorsements).
- **Curated catalogues and populated DBs never enter the repo.** `data/` is gitignored as policy, not accident. Only the small starter seeds under `seeds/` are committed; the maintained full catalogues are operational data.
- **Calm is the contract on every surface.** One awareness line per response, once per (user, item), gated on "do they actually use this" + the four impact questions (will it break / security / bill / upgrade). Email follows the same rule: a quiet week sends nothing.

## Integration preferences
- New discovery sources go in `src/fetchers/` as a `Fetcher` module wired into `index.ts` (discovered vs scouted), not bespoke call sites.
- Prefer deterministic, free signals (topic→modality maps, repo-shape heuristics, eligibility rules) over LLM calls; reach for the model only where metadata genuinely can't decide (library-vs-hype classification).
- Schema changes go through Drizzle migrations in `src/db/migrations/` (`npm run db:generate`), never hand-edited SQLite.
- MCP tool changes live in `mcp/src/server.ts`; the agent *playbook* (when to call what) lives in the skill, per the skills-vs-MCP split.

## Replen integration

<!-- replen-integration: v8 -->

On your **very first response** of each session:

1. **Skip the whole flow ONLY if** the user's first message is a
   pure trivial greeting with no content ("hi", "hey", "yo",
   "morning", "ok", "thanks"). One- or two-word pleasantries only.
   Statements, questions, vague intent, clarifying conversation —
   none of these qualify; the footnote should fire for all of them.

2. **Otherwise**, silently call `replen_match` WITHOUT passing
   a repo argument (let it default to the cwd repo). The response
   has two sections separated by `===` dividers:
     - USER-FACING MESSAGE: a pre-formatted footnote string
     - DATA: the structured candidate JSON for triage

3. **If the USER-FACING MESSAGE block is non-empty (not `(none)`),
   relay it VERBATIM at the end of your response.** Drop it in as
   a new paragraph after answering / asking / replying. Do NOT:
   - rewrite it
   - add a caveat ("though these don't look like a strong fit…")
   - narrow it to the user's current question topic
   - shorten it
   - decide it's "not worth surfacing"

   The string was built server-side specifically to be the message
   the user sees. The judgment about whether the matches fit is the
   USER's, made on the triage offer — not yours. Server-side we
   already encoded "Want me to triage them?" as the call to action;
   the user accepts or declines.

4. **If the USER-FACING MESSAGE block is `(none)`**, stay
   silent. No mention of Replen.

5. **Fire on every first response that isn't a pure trivial
   greeting** — including responses where you ask clarifying
   questions, restate the user's intent, or acknowledge them. The
   footnote goes at the end of your message regardless of message
   shape.

**Additional silent cases** (besides `(none)` USER-FACING MESSAGE):
- The user explicitly typed `/replen` — redundant.
- The user directly asked for Replen output ("anything from replen
  today?", "what's new from replen?"). Just answer.

**Do NOT use `replen_check_new` for the conversational footnote.**
That tool is cursor-based and meant for SessionStart shell hooks.
`replen_match` queries inventory state directly and is the right
primitive here.

**Don't call `replen_match` again on subsequent turns** — once
per session at start only. The user explicitly types
`/replen` if they want a fresh triage mid-session.

