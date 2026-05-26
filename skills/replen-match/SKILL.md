---
name: replen-match
description: Triage today's Replen candidates against the open codebase, in-session, using subscription tokens. Pulls the day's inventory from Replen, reads the user's local source, produces per-candidate writeups with verdict + effort + concrete file-level impact, then captures star/hide/handoff actions back to Replen. Invoke with `/replen-match` or by saying "run replen on this repo" / "what's new from replen?".
---

# Replen Match — in-session candidate triage

You are running the matching loop locally. Replen has fetched a list of
plausible OSS candidates from the wider ecosystem; you've got the user's
codebase open. Your job is to decide which (if any) are worth their
attention, write up the strong ones, and capture what they want to do
about them.

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

No marketing voice. No hype. The user is a working engineer; talk to
them like a peer. Concrete > clever.

#### 3d. Record the verdict

**After each candidate's writeup**, call the `replen_record_triage` MCP
tool with the structured verdict so it surfaces on the user's Activity
feed at the dashboard. Use the same `sessionId` (any opaque string,
e.g. timestamp `2026-05-26T10-32`) across every call in this session
so the feed can cluster them as one triage run.

```
mcp__replen__replen_record_triage(
  repo="owner/name",
  project="tech-news-site",      // slug, from scopedTo
  verdict="adopt",               // adopt|port|skip|defer
  score=87,                      // 0-100
  effortBand="quick",            // quick|moderate|deep
  oneLine="Drops in for lib/social/imageRenderer.ts — 30 min.",
  writeup="<full markdown body of the writeup you just composed>",
  sessionId="2026-05-26T10-32"
)
```

This call is what makes the agent's work visible. Without it, the user
only sees their own actions (star / hide) — they can't see "the agent
considered 5 candidates this morning and skipped 4 of them, here's
why." Record one event per candidate, including skips.

### Step 4 — Present + capture actions

After all writeups, summarise:

```
3 candidates triaged for tech-news-site:
  ✓ adopt: kribblo/node-ffmpeg-installer (high · quick) — ffmpeg-static swap
  ⏭ port:  tj/n (medium · moderate) — version-manager pattern
  ✗ skip:  vercel/turbo (medium · deep) — wrong runtime, already have Vite

For each, what would you like to do? (star / hide / handoff / skip)
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

**Inventory returns `scopedTo: null` with a `note` about "repo not in
your project list"**. The cwd isn't a known project. Ask the user:
"This repo isn't in your Replen projects yet. Add it via /projects?"
Then either stop or re-run with `?repo=` (empty) to see the global
firehose.

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
