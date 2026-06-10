---
name: replen-onboard
description: One-time background setup for Replen. Works through the user's active repos — reading each one's code, tidying thin/missing docs (never touching good ones), and building a tailored, grounded profile (a project report + capabilities) so Replen surfaces genuinely useful tools instead of generic ones. Runs autonomously in the background. Invoke with `/replen-onboard`, or when the user first sets up Replen and wants it configured properly across their projects.
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

## Step 2 — Per-repo grounding (autonomous; fan out if you can)

**Parallelise if your host supports it.** In Claude Code, spawn one background
subagent per repo (Task tool / background agents) so the sweep runs concurrently
and the user isn't blocked. If your host has no background/subagent primitive,
process repos sequentially — the autonomy matters more than the parallelism.

**Idempotent + resumable.** Before working a repo, you may check whether it's
already onboarded (it already has capabilities/facets). Re-running is always
safe — pushing again just overwrites — so an interrupted sweep resumes cleanly by
re-running and skipping repos already done.

**"Done" includes a version report.** A repo that has capabilities but has
never reported versions is NOT done — give it the lightweight backfill pass:
skip the doc work and re-profiling entirely, just read the lockfile + runtime
pins and call `replen_set_versions` (Step 2e.4). This is how an existing
portfolio gets version-aware deadlines/security awareness after upgrading
Replen — a re-run backfills versions across every repo in minutes.

For each in-scope repo, do this contract:

### 2a. Read the code (not just the README)

Read enough source to actually understand the project: entry points, the core
modules, manifests (`package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod`),
configs, schemas, and the files that implement its real work (the model/algo/
pipeline files, not the glue). This is what makes the grounding accurate — a
doc paraphrase is not enough.

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
engineer. Cover: **what it does and for whom · the stack · the algorithms/
techniques it uses and WHY · the data it operates on · how it's architected ·
what it's trying to achieve · constraints/non-goals.** Ground every claim in the
code (name the files/modules). Be specific about the tech, not the domain
marketing. This report is the single richest grounding artifact — it's what lets
Replen tell, e.g., "anomaly detection over telemetry time-series (no ML)" apart
from "image-defect anomaly detection".

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

### 2e. Push to Replen

1. **Register** the repo if it isn't already: `npx replen sync-projects` (scans
   local repos and pushes them). Ensure each in-scope repo has a GitHub remote so
   it's scoped by `owner/name`.
2. **Set domain tags** with `replen_set_tags` — broad domain labels.
3. **Set capabilities + report** with `replen_set_capabilities`, passing the
   grounded `capabilities` array AND the `report` from 2c. The server builds the
   facet vectors immediately and stores the report as grounding for its own
   summarization. Use the MCP tools, not hand-rolled `curl`.
   **Include `paths` on each capability** — up to 5 file paths that implement
   it (e.g. `{tag: "computer vision", …, paths: ["src/cv/transformations.py"]}`).
   Paths only, never code. You just read these files; recording WHERE each
   capability lives lets Replen point another of the user's projects straight
   at the implementation worth porting ("acme solved this — see src/cv/…").
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

## Step 4 — Warm + close out

1. Trigger an embedding/inventory pass so everything's ready: `replen_run` (it's
   async; the per-project facets you set are already live regardless).
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
