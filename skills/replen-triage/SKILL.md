---
name: replen-triage
description: Morning triage protocol for the replen pipeline. Fetches today's matches, evaluates the high-relevance ones against the open codebase, produces a styled HTML triage report you can scan + share, and optionally an HTML "briefing" for any repo you want a deep dive on. Invoke with `/replen-triage` or by saying "triage my digest". Requires the `replen` MCP server.
---

# Replen Triage

Run the morning replen triage. **Two output modes, default is terminal markdown:**

- **Default (terminal markdown):** Full triage in chat: bucketed match list, verdicts, action prompts. Stays in the terminal, no context switch. This is the right mode for a solo dev who lives in their CLI.
- **Opt-in HTML artifact:** When the user says *"save the HTML"*, *"give me an HTML report"*, *"export this for the team"*, or similar, write a styled HTML file (`~/replen/reports/triage-YYYY-MM-DD.html`) and open it. The HTML mode is for: sharing with non-CLI teammates, archiving a weekly report, or scanning >15 matches where chat wall-of-text breaks down.

**Decide which mode** before fetching data. If the user's prompt mentions HTML / share / export / team / report file → HTML mode. Otherwise → markdown.

You have access to the `replen` MCP server with these tools:
- `replen_today`: fetch matches from the last N days
- `replen_search`: full-text search prior matches
- `replen_starred`: view starred items + handoff state
- `replen_analyze`: pull raw README + repo meta + project profiles (does not run our LLM analyzer; you judge fit yourself with the user's codebase in context)
- `replen_handoff`: open a handoff PR in the matched project's repo
- `replen_feedback`: record good/bad/star/unstar/hide
- `replen_run`: trigger a fresh pipeline run (rate-limited; returns immediately with status)
- `replen_status`: live progress of the current/most-recent run — phase, candidate/match counts, and the same event stream the web UI shows. Pass `since=<event_id>` for incremental polling.

**Triggering a fresh run from chat:** if the user says "run replen now" / "refresh the digest" before triaging, call `replen_run`, then poll `replen_status` (every ~3s, passing the last event id back as `since`) until `inFlight: false`, then proceed to step 1. If `replen_run` returns `status: "rate_limited"` or `"in_flight"`, just skip to step 1 — there's already fresh data.

## Protocol

### 1. Fetch the window

Default: last 1 day, relevance `high` + `medium`. If the user said "this week" widen to 7 days. If they said "everything" widen to 30 + add `general-awareness`.

```
replen_today({ days: 1, relevance: ["high", "medium"] })
```

If `count === 0`, say so in chat and stop. Do **not** generate an empty HTML file.

### 2. Bucket the matches

- **High-fit:** score ≥ 75 AND `project !== "_general"`. These get deep evaluation.
- **Worth a glance:** score 60 to 74.
- **Skipped:** score < 60 OR project is `_general`.
- **Bad:** matches whose subject is actively off-topic for the user's stack; propose `replen_feedback(..., 'bad')` to train the source down.

### 3. Evaluate the high-fit bucket

For each match in score order:

1. Call `replen_analyze({ owner, name })`.
2. Read README + the matched project's `techSummary`. **Use your own judgment**; don't just echo the cached writeup. You have the user's open codebase in context; the pipeline didn't.
3. Decide one of: **KEEP** (+ handoff suggestion), **KEEP → revisit** (project's `githubFullName` not set), **SKIP**, **BAD**.
4. Hold a 2 to 3 sentence verdict per match in your head; you'll use it in the HTML.

Licence rules (auto-skip): MIT / Apache-2.0 / BSD = ✓. AGPL / SSPL = ask user. No licence = SKIP.

### 4a. Markdown output (default)

Print to chat, in this shape, using compact markdown:

```
### Triage · YYYY-MM-DD · N matches · M high-fit · K bad

**High-fit (ready for handoff):**
1. owner/name → project · score · one-line "why" · matchId X
2. ...

**Worth a glance (60 to 74):**
- owner/name → project · score · 5-word tag
- ...

**Skipped:** 4 (licence: 1, no-fit: 2, abandoned: 1)
**Marked bad:** owner/name (matchId X), owner/name (matchId Y) · sourced from <kind>

Say "open the PRs" / "apply the bad feedback" / "expand awareness".
```

Verdict lines = 1 sentence each. No headers per match. No HTML. Skip section 4b. Continue to step 5.

### 4b. Write the HTML triage report (opt-in only)

Only when the user explicitly asked for HTML / a shareable artifact (see top of skill).

Read `reference-triage.html` in this skill's directory; that is **the visual reference**. Match its style: same colour palette, same section structure, same chip / card / SVG layout, same copy-to-clipboard buttons. Adapt the content to today's data.

**Output path:** `~/replen/reports/triage-YYYY-MM-DD.html` (create the dir with `mkdir -p` if needed).

**Hard constraints on the HTML:**
- Single file, all CSS inline in `<style>`, no external assets, no CDN links, no remote fonts.
- Mobile-responsive (the reference already is; keep it).
- Buttons in the report **copy a Claude Code prompt to clipboard**, they do NOT call any API. Pattern: `<button class="copy-prompt" data-prompt="use replen to replen_handoff with matchId 96">Open handoff PR</button>`. The reference's `<script>` block at the bottom does the copy-to-clipboard wiring; include it verbatim.
- Include a tiny source-attribution bar chart at the top (the reference shows the pattern: pure CSS bars, no JS).
- The "Bad" section has a single "Apply both 👎" button that chains the feedback calls.
- The footer mentions when the next triage is and how to re-run.

After writing the file, open it:

```bash
open ~/replen/reports/triage-YYYY-MM-DD.html   # macOS
# (on Linux: xdg-open; on Windows: start)
```

### 5. (HTML mode only) Summarise in chat (≤80 words)

After writing+opening the HTML, just point at it briefly:

```
Triage complete · 14 matches · 3 high-fit · 2 marked bad.
→ ~/replen/reports/triage-2026-05-15.html (opened in browser).

The HTML has copy-to-clipboard buttons for each action. Or say "open the PRs" / "apply the bad feedback" and I'll do them here.
```

In markdown mode (default), step 4a *was* the deliverable; no separate summary step.

### 6. Wait for direction

Do **not** open handoff PRs or apply feedback automatically. The HTML report has buttons that copy the right prompts to clipboard; the user pastes back into Claude when ready.

When the user says "open the PRs" / "do the handoffs": call `replen_handoff({ matchId })` for each high-fit match.
When the user says "apply the bad feedback": call `replen_feedback({ matchId, action: 'bad' })` for each.

## Briefing sub-protocol: deep dive on one repo

When the user asks for a deep evaluation of a single repo ("brief me on roboflow/supervision", "is this worth integrating into &lt;project&gt;"), don't run the full triage. Instead:

1. Call `replen_analyze({ owner, name })`.
2. Read `reference-briefing.html` for the visual reference.
3. Write `~/replen/briefings/<owner>-<name>-YYYYMMDD.html` matching that style.
4. The briefing **must** include:
   - Verdict banner (KEEP / SKIP / BAD) at the top with 1 to 2 sentence reasoning.
   - Signal cards (licence, contributors, last push, postinstall hooks, secrets, star velocity) using small SVG icons. Green / amber / red border based on health.
   - **Two-column "your project vs. their repo"** comparison table.
   - **Dataflow SVG** showing current-vs-proposed architecture (the reference has the marker/arrow/box pattern; copy it).
   - **Before/after code diff** in a `<pre class="diff">` block. Use actual filenames from the user's codebase (read them yourself if uncertain).
   - **Risks & open questions** bulleted list; be specific, not generic.
   - **Collapsible README excerpt** (`<details>`) so the user can verify without opening the GitHub tab.
   - Action buttons at the bottom: "Open handoff PR" (primary), "Mark 👍", "Clone & start integrating", "Deeper dive on X".
5. `open` it. Briefer chat summary (≤60 words) pointing at the file.

Briefings are the natural Karpathy-style artifact: rich, single-file, shareable, scan-once. They replace what would have been a 2000-word wall of chat text.

## Failure modes

- **`replen` MCP not available:** tell user, suggest restarting Claude Code, stop. No `curl` workarounds.
- **`fetch failed`:** MCP can reach the binary but not the API; likely network/TLS. Report, don't retry.
- **`unauthorized`:** `DIGEST_TOKEN` rotated or wrong. Point at `/settings`.
- **No matches in window:** don't pad, don't write empty HTML. Suggest widening to 7d.
- **`open` command not available:** still write the file; tell the user the path. Skip the open step gracefully.

## Tone & quality bar

- **Terse in chat. Rich in HTML.** That's the split.
- No marketing words ("powerful", "robust", "comprehensive", "seamless").
- Verdicts are 2 to 3 sentences. If you need more, write a briefing.
- The HTML should look professional enough that the user could send the link to a colleague. The reference files set the bar; match it.
- Don't fabricate signals you didn't measure. If you didn't compute star-velocity, don't put a number in the signal card; drop the card or mark it "n/a".

## When NOT to run this skill

- If the user asks about a single specific repo (no comparison, no triage), use the briefing sub-protocol or just call `replen_analyze` once and answer in chat; don't run the full protocol.
- If the user is mid-task on something else and casually mentions digest, acknowledge and offer to run the triage when they want.
- If the user says "just give me a list" or "no HTML, just text", skip the HTML write. The chat summary becomes the deliverable.
