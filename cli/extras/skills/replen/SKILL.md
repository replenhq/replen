---
name: replen
description: Review Replen's suggestions for the current repo against your code. Replen surfaces libraries, dependency releases, and security advisories relevant to what you're building; this reads the codebase, gives each one a clear verdict and effort estimate with the specific files it affects, and records what you decide. Invoke with `/replen` or by saying "what's new from Replen?".
---

# Replen Match — in-session candidate triage

You are running **Brainstem**'s matching loop locally. **Watchtower** — Replen's
maintained network of ~1,250 sources (vendor changelogs, advisories, pricing
pages, release feeds, standards trackers, EOL calendars) — fetched the raw
events; **Brainstem** scored them against this codebase's capabilities; you've
got the user's codebase open and make the final call. Verdicts you record land
in **Atlas** and tune Brainstem's ranking for every future session.
Your job is to decide which (if any) are worth their attention, write up the
strong ones, and capture what they want to do about them.

**This runs entirely on the user's subscription tokens.** No API keys
get used. Replen's hosted side did the cheap structural filtering; you
do the expensive, code-grounded reasoning.

## Protocol

### Step 1 — Auth + context

1. Read `~/.replen/config.json` to get the user's DIGEST_TOKEN and base
   URL. If the file doesn't exist, stop and tell the user to run
   `npx replen` first.
2. Run `git remote get-url origin` to detect the repo. Extract
   `owner/name` from the URL.
3. Run `git log --oneline -20` to get a sense of recent activity (will
   inform scoring — what's the user actively working on?).

### Step 2 — Pull today's inventory

Call:

```bash
curl -sS -H "x-digest-token: $TOKEN" \
  "$BASE/api/inventory/today?repo=<owner/name>&days=2&limit=10"
```

Parse the JSON response. Note:

- `filterMode` — `tags`, `zero-knowledge`, or `fingerprint`
- `scopedTo` — confirms the project context the user has open
- `candidates[]` — the actual list to triage
- `candidates[].priorContext` — server-attached MEMORY: the user's earlier
  verdicts on this repo, and whether the matched capability is already
  covered by something they adopted/ported. Trust it — fold it into your
  verdict instead of re-deriving history, and don't push a candidate whose
  capability is covered unless it's materially better than the incumbent.
- `candidates[].source === "re-checked"` — a repo the user DEFERRED months
  ago that is still actively developed. Re-evaluate it against today's
  state of the project; the original "not now" note is in `priorContext`.
- `leap` — on quiet days the response may carry ONE portfolio connection
  (a cross-project / adjacency / cross-user leap) instead of candidates.
  `displayText` already words it; relay that and offer to explore it.
- `queuedActions` — work the user queued from their weekly brief / alert
  emails (or a past session). The footnote offers the oldest one; if the
  user says yes, DO the work (bump the dep, handle the deprecation,
  evaluate the repo), then call `replen_queue` with `action: "done"` and
  the item's id. If they decline for good, `action: "dismiss"`. Never
  leave a handled item queued — it will keep reminding.
- `candidates[].alternatives` — on health/security stakes ("your upstream
  is dying / has a CVE"), maintained catalogue libraries similar to the
  flagged repo, with cross-user adoption counts. Use them in the writeup:
  the verdict isn't just "X is risky" but "X is risky; Y is the maintained
  replacement, N similar projects adopted it".

### Step 2b — Keep the version picture fresh (cheap, do it)

If `git status` shows the lockfile changed since you last reported, or you
have never reported for this repo, call `replen_set_versions` with the
resolved DIRECT dependency versions from the lockfile (package-lock.json /
poetry.lock / uv.lock / Cargo.lock) plus runtimes under canonical keys
(`node` from .nvmrc/engines/Dockerfile, `python` from .python-version /
requires-python, `postgres`/`redis` when pinned in docker-compose). Names
and versions ONLY — never code. This is what turns Replen's deadline and
security lines from "worth checking your pins" into "affects `acme`
(3.10.12)" — and silences alarms for versions this repo verifiably isn't on.

This step is NOT optional, and not only about deadlines: the reported
names are also the matcher's "already a dependency" exclusion list. A
repo that never reports versions WILL get its own dependencies suggested
back to it as candidates (fastapi pinned in requirements.txt, fastapi in
the shortlist) — a shipped failure this step prevents.

If `candidates.length === 0`, tell the user "No new candidates today for
`<owner/name>`. Calm-cadence working as designed — 1-3 actionable
matches a month is the goal." Stop.

If 1+ candidates, continue.

### Step 3 — Per-candidate analysis

**Cap at 5 candidates.** If the inventory returned more, take the top 5
by `whyShortlisted` strength + stars + recency, defer the rest.

For each candidate, do this loop:

#### 3a. Gather signals

- WebFetch `<candidate.url>` — the GitHub repo page. Pull description +
  README.
- If the README mentions specific files (e.g. `src/index.ts`), WebFetch
  the raw file too (`https://raw.githubusercontent.com/<owner>/<name>/<default-branch>/<path>`).
- Search the user's local codebase for related code:
  - If the candidate is in a known package ecosystem, grep the user's
    `package.json` / `pyproject.toml` / etc. for the candidate's name
    or close variants (the user might already have a similar dep).
  - If the candidate solves a problem area (e.g. "social card generator"),
    grep the user's source for files that already do that work
    (e.g. `grep -rln "Canvas\|imageRenderer\|OG"` under `lib/` and `src/`).
  - If you find one, read the file to understand what the user has built.

#### 3b. Form a verdict

You're answering: **is this worth the user's attention right now?**

Verdicts:

- **adopt** — drop-in replacement / direct dep. The candidate does
  something the user genuinely needs and isn't doing well. Wire up.
- **port** — the candidate has an idea / pattern / algorithm worth
  copying, but the candidate's runtime / language / license is
  mismatched. Worth reading + adapting; not worth depending on.
- **skip** — the candidate is a worse version of what the user has, the
  candidate's runtime is incompatible, or the candidate's not actively
  maintained. Honest skips are valuable signal; don't manufacture
  reasons to keep something.
- **defer** — genuinely interesting but not NOW (too early / v0.x churn /
  blocked on a milestone the project hasn't hit). Defer is a real promise,
  not a soft skip: Replen automatically re-surfaces a deferred repo after
  ~3 months if it's still actively developed (`source: "re-checked"`).

**Watch for word-collisions** — the most common bad match. The candidate
shares a *word* with the matched capability but its real domain diverges:
the matched facet is "anomaly detection" (the user's is drone TELEMETRY) but
the candidate does IMAGE anomaly detection; "recommendation" means remediation
actions for the user but collaborative-filtering for the candidate; "S3" means
private IAM-managed storage but the candidate scans PUBLIC buckets. These are
skips — and worth recording precisely (see Step 4) so Replen stops surfacing
the pairing. Classify the reason: `modality-collision` (different data type),
`task-collision` (same data, different task), `wrong-posture` (e.g. defensive
vs offensive), `covered` (already have it), `low-quality` (workshop/abandoned).

Score the fit on a 0-100 scale:

- 80-100 = high (strong fit, clear adopt or port path, no major blockers)
- 50-79 = medium (real value, but caveats — port path required, or
  partial overlap, or active-area-mismatched)
- 0-49 = general-awareness or skip (interesting but not directly
  actionable; or definitely skip)

Estimate effort:

- **quick** — <1 day. Single-file swap, drop a dep, copy a file.
- **moderate** — 1-3 days. Real API delta, multi-site update, light port.
- **deep** — 1+ week. Framework adoption, paradigm shift, full rewrite.

#### 3c. Compose the writeup

Format **exactly** like this for each candidate:

```
### owner/name — VERDICT (score) · effort

**One-liner.** What the candidate is, in one sentence.

**Why this could help.** 2-3 sentences. Be specific. Reference the
user's actual files when possible:
- "Could replace `lib/social/imageRenderer.ts` (180 LoC) with a 30-line
  wrapper around X."
- "Their `<approach>` is what `scripts/auto-process.ts:124` tries to do
  in 80 lines; copying the algorithm saves ~50 lines and the buggy
  edge cases."

**Integration approach.** One of: cherry-pick / vendor /
cleanroom-rebuild / depend-on-it / n/a. Plus a one-sentence note on what
that means here.

**Caveats.** Anything to watch for — license, abandonment, runtime
mismatch, security flag. Empty list is fine; don't manufacture.
```

#### 3d. Record the verdict NOW — don't wait for the user

As soon as a candidate's verdict is formed, call `replen_record_triage`
for it — **before** you present the batch, and **without asking**.
Recording is observation, not action: it captures what you concluded
(verdict, score, reason code, one-liner, cosine) so the learning loop and
re-surfacing suppression actually fire. It is non-destructive and doesn't
foreclose anything — the user's star / hide / handoff choices in Step 4
are a separate axis layered on top.

The failure mode this rule exists to kill: a session triages four
candidates, presents them, ends with "want me to record these?", the
user moves on — and Replen learned NOTHING. The same four will come back.
A triage that isn't recorded never happened.

Only the user-judgment actions (star / hide / handoff / queue work) wait
for the user. Verdicts never do.

No marketing voice. No hype. The user is a working engineer; talk to
them like a peer. Concrete > clever.

### Step 4 — Present + capture actions

By this point every verdict is ALREADY recorded (3d). After all
writeups, summarise, and ask only about the actions that genuinely need
the user's call — skips need nothing further:

```
3 candidates triaged for tech-news-site (all verdicts recorded):
  ✓ adopt: kribblo/node-ffmpeg-installer (high · quick) — ffmpeg-static swap
  ⏭ port:  tj/n (medium · moderate) — version-manager pattern
  ✗ skip:  vercel/turbo (medium · deep) — wrong runtime, already have Vite

Want the adopt wired up, or any of these starred / hidden / handed off?
```

Then, for each candidate, capture the user's choice. For each action,
POST to `/api/state`:

```bash
curl -sS -X POST \
  -H "x-digest-token: $TOKEN" \
  -H "content-type: application/json" \
  -d '{"repo":"owner/name","status":"<star|hide|handed_off|surfaced>","projectId":<id-from-inventory-projectMatch-or-null>}' \
  "$BASE/api/state"
```

Status values:

- `starred` — user wants to come back to this. Won't re-surface.
- `hidden` — user dismissed it. Never re-surface unless they clear it.
- `handed_off` — user wants a handoff PR opened against their project.
  Use the existing `mcp__replen__replen_handoff` MCP tool to actually
  open the PR (server-side, needs write-scoped GitHub auth). Pass the
  PR URL back to /api/state via `handoffPrUrl` so future sessions see
  the status.
- `surfaced` — neutral "I showed this, user neither stared nor hid."
  Bumps the surface counter so the inventory deprioritises it next
  call without locking it out. POST this for EVERY candidate you
  presented, even the skips. It's the closing bookend of this skill.

### Step 5 — Close out

End with one line summarising what got actioned:

```
Done. 1 starred, 0 handoff PRs opened, 1 hidden, 1 skipped.
Run /replen-match again tomorrow for the next batch (or whenever a
fresh candidate shows up at session start via the hook).
```

## What to do if things go wrong

**Inventory call returns 401.** User's token expired or got rotated.
Tell them to run `npx replen` to re-auth.

**The project isn't scoped — `scopedTo: null`, a `note` about "repo not in
your project list", OR the cwd has no git remote.** Replen can only match
against a repo it has registered, and it scopes by the git remote. When it's
unscoped you'll get the global trending firehose — which is noise for this
codebase. **Do NOT triage the firehose** (manufacturing reasons to care about
random trending repos is exactly what this skill must not do).

Instead, **offer to onboard the project.** Lead with ONE line, not the whole
checklist: *"This project isn't set up with Replen yet, so I can only see the
global firehose (not matches for your code). Want me to scope it — init git,
create the repo, write the docs, and add tags? Then Replen can surface things
that actually fit."* If the user agrees, run this checklist:

1. **Git + GitHub.** If there's no git repo, `git init`. Create the GitHub
   repo using the user's existing `gh` auth — ask for owner/name or suggest a
   sensible default from the folder name, and confirm public vs private:
   `gh repo create <owner>/<name> --private --source=. --remote=origin --push`.
   If a repo exists locally but has no remote, just add + push the remote.
2. **Docs Replen can read.** Replen's scorer reads your `README.md` +
   `CLAUDE.md` to understand the project — that's the difference between
   useful matches and noise. Write a concrete `README.md` (what it is, stack,
   domain) if missing, and a `CLAUDE.md` optimised for Replen (run the
   `/replen-project-init` protocol, or draft the seven sections directly:
   what it is · stack · niche/domain · active areas · constraints/non-goals ·
   anti-patterns · integration preferences). Use the project's real domain
   vocabulary, not abstractions.
3. **Register + tag + set capabilities.** Register the repo: `npx replen
   sync-projects` (scans the local repos and pushes them to Replen). Then, from
   the code you just read:
   - **Set domain tags** with `replen_set_tags` — broad domain labels (e.g. for
     a Python CCXT market-making engine:
     `["crypto","trading","market-making","ccxt","quant","backtesting"]`).
   - **Set technical capabilities** with `replen_set_capabilities` — short,
     GitHub-searchable tech terms for what the project DOES at the tech level.
     Aim for **8-15** and be **SPECIFIC**. **Send GROUNDED objects, not bare
     strings** — `{tag, descriptor, modality}` for each capability:
     - `tag` — the short searchable term (`"anomaly detection"`).
     - `descriptor` — ONE sentence grounding the tag in the ACTUAL CODE you
       just read: what DATA it operates on, the specific task, key constraints.
       This is what stops word-collisions. `"anomaly detection"` alone collides
       with image-defect libraries; `{tag:"anomaly detection", descriptor:
       "rule-based detection over drone telemetry time-series — link-loss,
       GPS-drop, battery-sag; no ML", modality:["timeseries"]}` does not.
       Read the real source (the taxonomy/model/config files), not the README.
     - `modality` — array from EXACTLY: `image, video, timeseries, tabular,
       text, audio, geospatial, graph, 3d, code, network` (`[]` if none apply).
       A satellite-imagery segmenter is `["image","geospatial"]`; a recsys is
       `["tabular"]`.

     Break broad capabilities into the concrete techniques the code uses (not
     just `"web scraping"` but `headless browser`, `cloudflare bypass`,
     `proxy rotation`, …). Derive all of it from the imports/deps and code, not
     guesses. This is the highest-leverage step: the server builds the project's
     facet vectors from these IMMEDIATELY, and the grounded descriptor + modality
     are exactly what make matching separate "same word, different data" — the
     single biggest source of bad matches.

   **Do NOT tell the user to set tags/capabilities on the web** — that's the
   sticky step this replaces; set them with the tools. (They can fine-tune later
   at app.replen.dev/projects.) These matter most right after onboarding — they
   give a fresh project working query vectors before any server-side inference.
4. **Embed it now (don't wait for the daily run).** A freshly-registered
   project has no embedding yet, so matching falls back to language/tags only
   (noise) until the next scheduled run. Trigger an immediate run with the
   `replen_run` tool — it builds the project's summary + embedding + initial
   candidates from the README/CLAUDE.md you just pushed. It's async: poll
   `replen_status` until the phase reports inventory ready (~1–3 min). Tell the
   user it's processing.
5. **Re-run.** Once the run finishes, call `replen_match` again — now scoped
   AND embedded, matching against the real code (a dev-tool that only shared the
   project's language now scores low on cosine and gets floored out).

Note on recording actions: always use the MCP tools — `replen_state` (star /
hide / handoff), `replen_record_triage` (your verdict), `replen_set_tags` — for
any write back to Replen. Don't hand-roll `curl` to the API for these; the MCP
path is the intended mechanism and avoids tripping host permission classifiers
on the candidate repo name in a curl payload.

**Never record a bare verdict.** Every `replen_record_triage` call — including
quick skips made outside this full protocol (e.g. from the session-start
footnote) — must carry at least `oneLine` and `cosine`. A verdict with no
reasoning shows up in the user's Atlas dossier and vault as "bare verdict —
the agent recorded no reasoning", which is a bug report with your name on it.

When you call `replen_record_triage`, **pass the contextual fields** so Replen
learns: `matchedFacet` (copy the `matchedFacet` from the candidate's
replen_match data), `facetModality` (the data modality of that capability —
e.g. `"timeseries"`, `"image"`), `reasonCode` (`fit` / `modality-collision`
/ `task-collision` / `covered` / `wrong-posture` / `low-quality` / `other`),
and `cosine` (copy the candidate's `cosine` value verbatim — paired with your
verdict it calibrates the relevance floor for this project, and your
adopt/skip pattern continuously tunes the ranking via the taste vector).
A skip coded `modality-collision` teaches Replen that this repo fits a
*different* modality — so it stays available for the right project but stops
colliding with this one. A skip coded `covered` is the strongest signal you
can send: it tells Replen the capability is **already built in this repo**, so
it stops probing that facet entirely and won't surface a different tool for it
next session. Use `covered` ONLY when you've confirmed the implementation in
the code (e.g. the repo has its own `services/llm_client.py`), not just because
a similar dependency exists — that's what makes "we already do this" stick to
the capability instead of replaying every session against a new candidate.

**Candidate's README is unreachable (WebFetch 404)**. Note it in the
writeup (`Caveats: README unreachable; verdict based on description
only`) and proceed with a more conservative score.

**Local codebase is large / search is slow.** Don't do `grep -r` from
the root; scope to `src/`, `lib/`, `app/`. Skip `node_modules`,
`dist`, `build`, `.next`, `vendor`. If you genuinely can't find
related code in 3 grep attempts, say so in the writeup ("No directly
related code found in src/; verdict based on README + project shape
only").

**No project tags configured (inventory returns
`whyShortlisted: "no project tags configured; showing unfiltered"`)**.
The user hasn't set up filter-mode B's tag list. Mention it once: "Heads
up — you'd get sharper matches if you set project tags at /settings.
Continuing with unfiltered for now."

## Atlas tiles — local memory for any agent

Replen keeps an agent-readable markdown vault at `~/.replen/atlas/` — the
user's whole portfolio as linked notes: every project and what it does,
every capability (with how it's known: `grounded`/`extracted`/`inferred`),
every past decision with its reason code, plus themes and blind spots.
The MCP server refreshes it in the background (at most twice a day);
`replen atlas` forces a rewrite.

Use it whenever you need CROSS-PROJECT context: "what else does this user
build?", "have we solved X in another repo?", "what did we decide about
Y last quarter?". Start at `MAP.md`, or call `replen_recall` for a direct
query. Reading the tiles beats re-deriving the portfolio from scratch —
they're the memory layer, and they're already on disk.

## When NOT to run this skill

- The user is mid-task and just wants help with the current thing. The
  match flow is interruptive; don't volunteer it. Only run when invoked
  via `/replen-match` or when the user explicitly asks.
- The repo isn't a tracked Replen project. Tell them how to add it,
  don't try to match against an unknown project.
- The session-start hook already surfaced matches in the opening
  context and the user hasn't asked for more. Don't double-deliver.

## Voice guide

- **Concrete.** "Replaces `lib/foo.ts:42-180`" beats "could simplify
  your image pipeline."
- **Honest.** Skip is a valid verdict, often the right one. Don't pad.
- **One-block-per-candidate.** Don't sprawl. The user will read 1-3
  candidates; if you write 9 paragraphs each, they bail.
- **Show your work.** When the verdict is "adopt", say WHAT in the
  user's code it replaces. When "port", say WHAT idea is worth
  porting. When "skip", say WHY.
- **No salesmanship.** Don't end with "would you like to learn more?"
  The user will tell you what they want.
- **Match the calm-cadence positioning.** Most days, no candidates.
  When there are some, they're real. Treat them that way.
