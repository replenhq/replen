---
name: replen-onboard
description: One-time Replen setup — profiles your active repos so matches are relevant, not generic. Runs autonomously in the background. Invoke with `/replen-onboard`.
---

# Replen onboarding — autonomous, background, multi-repo setup

You are setting Replen up properly across the user's projects. The better the
grounding you build now, the sharper Replen's matches are forever after — and it
all happens in-session, on the user's own agent, so nothing leaves their machine
except the project profile you build.

**This skill is designed to run AUTONOMOUSLY.** After ONE upfront confirmation of
the repo list, do NOT stop to ask questions — every policy decision is fixed
below. The user should be able to kick this off and keep working (or let a
background agent run it) without babysitting it.

## Step 0 — Show the brief, then auth

Show the user this brief verbatim, then proceed:

> **Setting up Replen.** Your coding agent is going to set Replen up in the
> background. It'll go through your active repos — reading each one to understand
> what it does and the tech it uses, tidying up thin or missing docs (never
> touching good ones), and building a tailored profile so Replen surfaces
> genuinely useful tools instead of generic ones. It runs in the background, so
> just keep working — there's nothing to wait on. **No code leaves your agent**;
> it only sends Replen the project profile it builds, and any doc changes show up
> as normal git edits you can review or roll back.

Then read `~/.replen/config.json` for the DIGEST_TOKEN + base URL. If it's
missing, stop and tell the user to run `npx replen` first.

## Step 1 — Discover in-scope repos (the one allowed interaction)

Find the user's local repositories and filter to the ones worth onboarding.

> **Shell portability (read before scripting the scan).** Assume macOS/zsh:
> - **BSD `sed`/`grep` reject GNU regex** like `+?` and `\|` — don't pipe remote
>   URLs through `sed -E 's#…(…)?…#'`; parse `owner/name` with `basename`/`${}`
>   or `git remote get-url` + a simple `cut`/parameter-expansion instead.
> - **`gh` is often shadowed** by a shell function/alias — if `gh` errors weirdly,
>   call the real binary (`command gh …` or `/opt/homebrew/bin/gh`).
> - **zsh does NOT word-split unquoted vars** — build repo lists as arrays
>   (`repos=(a b c); for r in $repos`), not space-strings in a `for` loop.
> Get these right up front; debugging them mid-sweep wastes cycles and looks broken.

1. **Locate local clones.** Look in the parent directory of the cwd (sibling
   repos) and any obvious code root (`~/github`, `~/code`, `~/src`, `~/dev`).
   A repo is any directory containing `.git`.
2. **Scope filter — apply ALL:**
   - **Active in the last 6 months:** `git -C <repo> log -1 --format=%ct` →
     keep only if the last commit is within ~183 days.
   - **Not a fork**, **not archived** (skip mirrors/vendored clones; check
     `gh repo view <owner/name> --json isFork,isArchived` when a remote exists).
   - Has a git remote (so Replen can scope by `owner/name`). Note any local-only
     repos and skip them.
3. **Present the list and get ONE green light.** Show the in-scope repos and ask
   the user to confirm or trim — e.g. *"Found 8 active repos to onboard: acme-web,
   acme-api, … — go, or want me to drop any?"* This is the **only** question you
   ask. Once confirmed, run the rest autonomously.

## Step 1.5 — Pre-flight: decide the MINIMUM work per repo (do NOT skip this)

Before grounding anything, call **`replen_onboard_state`** ONCE. It returns
every repo's server-side state (`hasCapabilities`, `hasVersions`, `hasReport`).
Cross-reference each in-scope LOCAL repo against it and bucket it — this is what
turns a 24-minute re-run into ~2 minutes, and a re-run should mostly be skips:

- **FULL ground** — not listed, or `hasCapabilities=false`. Read the code, do
  the whole 2a–2e contract. (On a true cold start every repo is here — expected.)
- **VERSION-ONLY backfill** — `hasCapabilities=true` but `hasVersions=false`.
  Do NOT read the codebase or touch docs. Just read the lockfile + runtime pins
  and call `replen_set_versions` (2e.4). Seconds per repo, no LLM-heavy read.
- **SKIP** — `hasCapabilities && hasVersions && hasReport` and the repo's
  `git log -1` hasn't moved since it was last grounded. Already done; leave it.

State the plan in one line ("12 to ground, 18 version-backfills, 3 skips") so
the user sees why it'll be fast. **A full code-read on an already-grounded repo
is wasted work — the pre-flight exists to prevent exactly the 24-minute re-run.**

**Then amortize the FULL-ground bucket by stack (cuts the cold read hardest).**
A portfolio's repos cluster by stack — 8 Next.js + Drizzle + Firebase apps share
~80% of their *technical* capabilities, which is exactly what Replen matches on
("describe the tech, not the application"). So the expensive repeated thing is
the *shared* thing. Group the full-ground repos by a cheap **stack fingerprint**
read from each manifest you already have to open (framework + ORM/DB + a couple
of capability-bearing deps, e.g. `next+drizzle+firebase` / `fastapi+pytorch` /
`hardhat+solidity`). Within each group:
- Ground the **first** repo fully (the 2a–2e contract).
- For each **sibling**, hand its grounding subagent the leader's pushed
  `capabilities` array as a **TECH-ONLY draft to verify and diff** — the subagent
  reads only enough to confirm which shared capabilities actually apply, drop the
  ones that don't, and ADD this repo's domain-specific capabilities + its own
  `paths`/versions. It does NOT re-derive the shared stack from scratch.
This is a *draft to verify*, never auto-accept (the "don't invent capabilities
the code doesn't show" rule still holds), and you template only TECH capabilities
— never the report, domain tags, or anything application-specific (privacy +
no cross-repo domain bleed). Singletons (no stack sibling) just full-ground
normally.

Mechanically: process the group leader first and have its subagent **return its
`capabilities` array** (the `{tag, descriptor, modality}` objects, paths
stripped) in its final message; the orchestrator passes that array into each
sibling subagent's prompt as `STACK DRAFT (verify against THIS repo, don't
auto-accept)`. Groups still run concurrently with each other — only the
leader→siblings step within a group is ordered. If returning the array is
impractical for your host, fall back to plain full-ground for the siblings (no
correctness loss, just no speed-up).

## Step 2 — Per-repo grounding (autonomous; fan out if you can)

**Parallelise if your host supports it.** In Claude Code, spawn one background
subagent per repo in the FULL-ground bucket (Task tool / background agents) so
the sweep runs concurrently. Version-only backfills are cheap enough to batch
inline (no subagent needed). If your host has no subagent primitive, process
sequentially — autonomy matters more than parallelism.

**Cold-start at scale (tens → hundreds of repos).** A new user with 200 repos
must not block on a 3-hour read. Tier the work so value lands fast:
1. **Order by recency** — ground the most-recently-committed repos first; those
   are what the user is actively working on and will see footnotes for soonest.
2. **Cap concurrency** to what the host sustains (Claude Code parallel subagents
   are capped automatically; don't try to launch 200 at once — launch in waves).
3. **Version-first is the DEFAULT for the long tail** (not a fallback). Pick a
   full-ground budget N (the most-recently-committed repos — say the active ~20–
   30, or what the user confirms). Everything BEYOND N gets a version-only
   backfill: cheap, no code read, and it turns on EOL/security/dependency-
   exclusion awareness immediately. Full capability grounding for the tail then
   happens **just-in-time on first `/replen` in that repo** — the `/replen`
   skill grounds a `hasVersions && !hasCapabilities` repo inline before triaging
   (its Step 2a). This is the key to a hundreds-of-repos cold start staying
   minutes, not hours: you never speculatively read 170 repos the user may never
   open. Tell the user: "Grounding your N most-active repos now; the rest get
   version-aware coverage immediately and a full profile the first time you open
   them." Don't silently drop the tail — it's covered, just lazily.

**"Done" includes a version report** — covered by the VERSION-ONLY bucket above.

For each repo in the FULL-ground bucket, do this contract:

### 2a-pre. Check for an existing knowledge graph FIRST (the adapter step)

Replen doesn't map code internals — it ingests whatever already does. Before
reading raw source, look for pre-digested knowledge and use it as your primary
grounding source (faster AND richer than a cold code-read):

- **Graphify vault** — an Obsidian-compatible markdown vault with frontmatter
  + `[[wikilinks]]` + EXTRACTED/INFERRED/AMBIGUOUS-style provenance tags
  (commonly in-repo as `graph/`, `vault/`, `.graphify/`, or alongside the
  repo). Its entity/concept notes ARE the capability map: distill capabilities
  from them, take descriptors from the note bodies, and use the files each
  note links as the capability's `paths` evidence anchors.
- **Plain Obsidian vault / docs vault** — same treatment, lower confidence.
- **ADRs** (`docs/adr/*.md`, `doc/decisions/`) — architecture decisions are
  high-grade descriptor material and often name the load-bearing files.

**Also check vaults the user pointed us at OUT of the repo.** Read
`~/.replen/config.json`; if it has a `vaults` block, consult those paths too —
`vaults.byRepo["<owner/name>"]` for this repo specifically, and every
`vaults.global[]` path (a central Obsidian vault that covers many repos). These
are first-class grounding sources, same treatment as an in-repo vault. This is
how a user feeds a central vault that auto-detection can't see.

If you find NO knowledge graph — not in the repo and none configured — and the
session is interactive, ask once: "Do you keep design notes or an Obsidian /
Graphify vault for this project? If so, point me at it with
`npx replen vault <path>` (or `npx replen vault <owner/name>=<path>`) and re-run
/replen-onboard — I'll ground from it." Then fall back to the code-read.

If you ground from one of these, START the report (2c) with one line:
`Grounding source: Graphify vault at <path>` (or `Obsidian vault…` / `ADRs…`)
— it renders into the user's Atlas tiles, linking the two tools. Then skim the
code only to VERIFY (the vault may be stale); don't re-derive what it already
holds. Privacy is unchanged: only capabilities/descriptors/paths/tags leave
the machine, exactly as with a code-read — never vault content or code.

**Use the note→note `[[wikilinks]]` BETWEEN concept/entity notes as capability-
BOUNDARY evidence** (today you only follow note→FILE links, for `paths`). A tight
same-as cluster of concepts → emit ONE capability tag (don't split a thing the
user models as one). A concept fanning out to distinct linked clusters → split
into the concrete techniques (this is the 2d "break broad capabilities" move,
now backed by the user's own structure). A typed/deliberate cross-link between
two distinct concepts → keep them as two RELATED tags. Then, if the vault gave
you this structure, assemble the optional `concepts` array described in 2d.

### 2a. Read the code (not just the README)

Read enough source to actually understand the project: entry points, the core
modules, manifests (`package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod`),
configs, schemas, and the files that implement its real work (the model/algo/
pipeline files, not the glue). This is what makes the grounding accurate — a
doc paraphrase is not enough. (Skip the deep read when 2a-pre found a fresh
knowledge graph — verify instead.)

### 2b. Assess doc quality → `good` | `thin` | `none`

- **`good`** — the README/CLAUDE.md already explain what it is, the stack, and
  the domain accurately. **Use as-is. NEVER overwrite or rewrite a good doc.**
- **`thin`** — a doc exists but is sparse/outdated/missing the tech picture.
  **Augment, don't replace:** add the missing parts (what it is, stack, domain,
  active areas, constraints), keeping the user's existing prose.
- **`none`** — no usable docs. **Create** a concise, accurate `README.md` (what
  it is · stack · domain) and a Replen-useful `CLAUDE.md` (what it is · stack ·
  niche/domain · active areas · constraints/non-goals · anti-patterns ·
  integration preferences), grounded in the code you just read. Use the
  project's real vocabulary. Do NOT invent capabilities the code doesn't show.

**Doc-write policy (firm):**
- Never silently overwrite. Make doc changes on a branch
  (`replen/onboarding-docs`) or, if the user works trunk-based, as clearly
  flagged uncommitted edits they can review. The user owns every change as a
  normal git diff and can roll it back.
- A `good` doc is never touched.

### 2c. Write the grounded project report

Produce a comprehensive write-up of the repo — the thing you'd hand a new
engineer. Cover: **the stack · the algorithms/techniques it uses and WHY · the
data it operates on (shape/modality) · how it's architected · the technical
problem it solves · constraints/non-goals.** Ground every claim in the code
(name the files/modules). Be specific about the tech, not the domain. This
report is the single richest grounding artifact — it's what lets Replen tell,
e.g., "anomaly detection over telemetry time-series (no ML)" apart from
"image-defect anomaly detection".

**Respect the cover — describe the TECH, never de-sanitize the application.**
This report leaves the machine (stored server-side as grounding), so it must
read like the repo's own public docs, not like a leak. Replen only needs the
technical capability profile — what algorithms run on what data shape — which is
modality-precise without any sensitive real-world detail. If the README/CLAUDE.md
deliberately present a sanitized framing (e.g. "urban-infrastructure
segmentation") that differs from what the code's identifiers imply, FOLLOW THE
DOCS' framing: write "semantic segmentation of overhead imagery into vector
polygons," NOT the specific real-world thing it detects or who uses it. Never
copy a sensitive internal codename, end-user, deployment, or real-world target
into the report or the descriptors — the capability is the signal; the
application is exactly what stays local. When in doubt, describe it as the
public README does.

### 2c-thesis. Capture the product THESIS (what it's trying to BE)

Capabilities say what a project technically *does*; the **thesis** says what it's
trying to *be* and where it's *heading* — and that's a far better relevance test
than any capability slot ("does this advance a contested-airspace decision-
support platform?" beats "does this do OSINT?"). Replen now matches and triages
against it, so capture it:

- **First, look for an explicit thesis the user already keeps** — `goals.md`,
  `GOALS.md`, `handover.md`, `HANDOVER.md`, `ROADMAP.md`, `PRD.md`, `vision.md`,
  `docs/product*.md`, or the "what it is / active areas" sections of CLAUDE.md.
  These are the user's own words for the mission — use them as the primary
  source (same adapter spirit as the knowledge-graph step 2a-pre).
- **Derive two things:**
  - `purpose` — 1–2 sentences: what the product is trying to be and what makes
    it distinct. The mission, not a feature list.
  - `goals` — a few outcome directions it's heading toward (e.g. "real-time
    multi-sensor fusion", "sub-second COA ranking").
- **Respect the cover** exactly as for the report: the thesis describes intent
  and tech direction, never a sensitive codename / end-user / operational target.
  Follow the framing the user's own docs use.

Pass both to `replen_set_capabilities` (`purpose`, `goals`) in 2e.

### 2d. Derive grounded capabilities

From the report + code, produce 8–15 **grounded** capability objects — NOT bare
strings. Each is `{tag, descriptor, modality}`:
- **`tag`** — short, GitHub-searchable tech term (`"anomaly detection"`,
  `"satellite imagery"`).
- **`descriptor`** — one sentence grounding it in the actual code: the data it
  operates on, the specific task, key constraints. This is what prevents word-
  collisions.
- **`modality`** — array from EXACTLY: `image, video, timeseries, tabular, text,
  audio, geospatial, graph, 3d, code, network` (`[]` if none apply).

Break broad capabilities into the concrete techniques the code uses. Be
specific — `cloudflare bypass`/`proxy rotation`, not just `web scraping`.

**If you grounded from a vault (2a-pre), also assemble a `concepts` array** so
Replen can traverse the user's OWN graph for cross-repo leaps. For each
concept/entity note — **NEVER a file/symbol/function/class/module note** — emit
`{title, grounds: [the capability tags this note grounded], links: [{to: <other
concept title>, rel}]}` where `rel` is one of `relates | refines | depends |
same-as | contrast`. Pass it to `replen_set_capabilities` in 2e (it's optional —
omit it entirely if there's no vault). Hard rules (already true for everything
else, restated because this is new structure leaving the machine): lift only
concept/capability-LEVEL notes; note BODIES and code never leave; a note→file
link stays as a capability `path`, never a concept link; respect the cover —
sanitize titles, no codenames.

**Also capture architectural PRACTICES as capabilities.** Beyond what the code
*does*, note the distinctive structural *moves* it makes — these are what let
Replen suggest a pattern to your OTHER projects ("Acme made its domain model
data-driven; this data-heavy project should consider it"). Include a capability
for any deliberate practice you find: a **data-driven domain ontology** (entity
types/relationships stored as DATA/rows, not hardcoded — configurable without a
redeploy), **event sourcing**, **outbox pattern**, **CQRS**, **pgvector
semantic search**, **feature store**, etc. Use the standard practice name as the
`tag` (so it matches Keystone's practice registry). Respect the cover — describe
the practice's STRUCTURE, never the sensitive entity names it models (for a
covered repo, "a configurable Postgres-backed domain ontology — entity types,
typed properties, computed properties as rows", never the entity names).

### 2e. Push to Replen

1. **Register** the repo if it isn't already. The per-repo `replen_set_tags` /
   `replen_set_capabilities` push below resolves owner-tolerantly and CREATES
   the project row if missing — so for the fan-out flow you usually don't need a
   separate register step at all. If you do want a bulk pre-register, run
   `npx replen sync-projects` **from a neutral directory like `$HOME`** (e.g.
   `cd "$HOME" && npx replen sync-projects`) — NOT from inside a checkout named
   `replen`, where the local package shadows the CLI and npx fails with "could
   not determine executable to run". `npx replen@latest sync-projects` also
   sidesteps the shadow. Ensure each repo has a GitHub remote so it scopes by
   `owner/name`.
2. **Set the domain tag cloud** with `replen_set_tags`. This is the single
   biggest lever on match quality — do it DENSE and RANKED, not a handful of
   broad labels:
   - Emit AS MANY grounded tags as the code genuinely supports (aim 25–50+, no
     hard cap), ordered MOST-CENTRAL FIRST. Density is what makes matching work.
   - Describe the WORLD the project operates in, NOT how it's built: the
     industry/sector (`estate-agents`, `letting-agents`, `property`, `proptech`),
     the job-to-be-done (`lead-generation`, `lead-routing`), and the
     entities/data it touches (`uk-postcodes`, `uk-addresses`, `landlords`,
     `property-listings`).
   - DISAMBIGUATE BY DENSITY. A lone ambiguous tag is dangerous — `uas` could
     mean anything. Whenever a term is ambiguous, ALSO emit its synonyms,
     abbreviations, expansions and broader/narrower neighbours (`uas`,
     `unmanned-systems`, `unmanned-aerial-systems`, `uav`, `drone`, `drones`,
     `military-drones`, `counter-uas`). The COLLECTIVE pins the meaning: a
     candidate that hits one term but none of its neighbours is a different
     world and scores low.
   - QUALIFY AMBIGUOUS HEAD-NOUNS. If a tag's core noun is ambiguous ACROSS
     fields (`agent`, `carry`, `model`, `pipeline`, `driver`, `mission`),
     prefix it with the domain so the compound carries the meaning —
     `estate-agent-matching` NOT `agent-matching`, `funding-carry` NOT `carry`.
     A bare head-noun like `agent-matching` decomposes in embedding space toward
     the wrong field (AI agents) and drags the whole project's centroid with it.
   - GROUNDED ONLY — every tag supported by code you actually read; never
     aspirational (don't add `scraping` if it doesn't scrape).
   - EXCLUDE: stack / framework / language (`next.js`, `react`, `firebase`,
     `typescript`, `fastapi`, `postgres` — captured by `replen_set_versions`,
     not domain) and generic SaaS plumbing every app has (`authentication`,
     `signup`, `user-roles`, `subscription-management`, `form-validation`,
     `crud`, `admin-dashboard`). They match everything, so distinguish nothing.
3. **Set capabilities + report + thesis** with `replen_set_capabilities`, passing
   the grounded `capabilities` array, the `report` from 2c, AND the `purpose` +
   `goals` from 2c-thesis. The server builds the facet vectors immediately, stores
   the report as grounding, and hands the thesis to the triage agent so candidates
   are judged against the mission. Use the MCP tools, not hand-rolled `curl`.
   **Include `paths` on each capability** — up to 5 file paths that implement
   it (e.g. `{tag: "computer vision", …, paths: ["src/cv/transformations.py"]}`).
   Paths only, never code. You just read these files; recording WHERE each
   capability lives lets Replen point another of the user's projects straight
   at the implementation worth porting ("acme solved this — see src/cv/…").
   **If you grounded from a vault, also pass the `concepts` array from 2d** —
   concept titles + their `[[wikilinks]]` only (never file/symbol notes, never
   bodies). Replen turns these into graph nodes + your-own-graph leaps. Omit it
   when there's no vault.
4. **Report pinned versions** with `replen_set_versions` — the resolved DIRECT
   dependency versions from the lockfile (package-lock.json / poetry.lock /
   uv.lock / Cargo.lock), plus runtimes under canonical keys (`node` from
   .nvmrc/engines/Dockerfile, `python` from .python-version/requires-python,
   `postgres`/`redis` when pinned in docker-compose). Names + versions ONLY,
   never code. This makes EOL/deprecation/security awareness name the affected
   repos with certainty — and suppresses alarms for versions the repo
   verifiably isn't on.

## Step 3 — Group multi-repo products

If several repos are one product (e.g. `acme-web`/`acme-api`/`acme-cv`), group
them with `replen_set_product` so Replen unions the whole product's capabilities
when the user is in any one of them.

## Step 4 — Close out

1. Nothing to trigger — the per-project facets, capabilities, and versions you
   set are live immediately, and the next scheduled run refreshes the candidate
   inventory automatically.
2. Summarise what you did, calmly:

```
Replen onboarding done — 8 repos grounded.
  · docs: 2 created, 1 augmented, 5 already good (untouched)
  · capabilities + report set for all 8; acme-* grouped as one product
  · doc changes are on branch `replen/onboarding-docs` for your review
Replen will now surface genuinely relevant tools for these repos.
```

## Policy recap (so the run stays autonomous)

- Scope: local repos, active in last 6 months, non-fork, non-archived, with a
  remote.
- One question only: confirm/trim the repo list (Step 1). Everything else is
  fixed.
- Never overwrite a `good` doc; doc writes go on a branch / clearly flagged.
- Capabilities are GROUNDED objects (`{tag, descriptor, modality}`) + a report —
  never bare strings.
- Re-running is safe and idempotent; that's how an interrupted sweep resumes.
- Nothing leaves the agent except the project profile (tags, grounded
  capabilities, report) you push to Replen.

## When NOT to run this

- The user only wants today's matches for the current repo → that's `/replen`,
  not this. This skill is the one-time (or occasional) multi-repo setup sweep.
- A single fresh repo just needs scoping → the `/replen` skill's onboarding
  fallback handles one repo; use this when setting up the whole portfolio.
