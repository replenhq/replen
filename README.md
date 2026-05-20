<div align="center">
  <img src="logo.svg" width="120" alt="Replen">
  <h1>Replen</h1>
  <p><strong>Smart AI Development workflows</strong></p>
  <p>The AI that asks: <em>"can we do this better?"</em></p>

  <p>
    <a href="https://www.npmjs.com/package/replen"><img src="https://img.shields.io/npm/v/replen?style=flat-square&color=d97706" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/replen"><img src="https://img.shields.io/npm/dm/replen?style=flat-square&color=d97706" alt="npm downloads"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--MIT-blue?style=flat-square" alt="FSL-1.1-MIT License"></a>
    <a href="https://replen.dev"><img src="https://img.shields.io/badge/website-replen.dev-d97706?style=flat-square" alt="Website"></a>
  </p>

  <p>
    <a href="https://replen.dev">Website</a> ·
    <a href="https://docs.replen.dev">Docs</a> ·
    <a href="#quickstart">Install</a> ·
    <a href="#workflow">Workflow</a> ·
    <a href="mcp/">MCP</a> ·
    <a href="skills/">Skill</a> ·
    <a href="#self-host">Self-host</a> ·
    <a href="https://app.replen.dev">app.replen.dev</a>
  </p>
</div>

---

**AI coding tools are reactive. Replen is proactive.**

Claude Code, Codex, Cursor: they wait for you to ask. None of them look at your codebase on their own and ask *"what could we be doing better here? what are others doing we could learn from?"*

Replen does. Every morning, on every project, against the live ecosystem. For each new repo in your niche, it does the comparative work a senior dev would: read it, compare against your codebase, decide (adopt as-is, port a specific idea, or skip) with the reasoning written in. The keepers come with a PR-ready briefing your AI coding workflow (Claude Code, Codex, whichever) picks up and integrates.

The training-cutoff problem makes this more urgent. Every LLM has a date past which it just doesn't know, and your AI tool will happily confabulate around the gap. But the deeper reason is simpler: good engineering means asking *"can we do this better?"* continuously. Replen runs that loop for you.

Pulls from gh-trending, TikTok, Threads, Reddit, HN, plus niche-scouted GitHub searches tuned to your project's domain. Secrets encrypted at rest, bring-your-own-keys. Hosted at [app.replen.dev](https://app.replen.dev), or self-host (no Docker required).

## Quickstart

**Two ways in. Both passwordless. Both finish with your first digest building itself in front of you.**

### Hosted (recommended for most)

Open <a href="https://app.replen.dev">app.replen.dev</a>, click **Continue with Google** or **Continue with GitHub**, paste two keys, watch it run.

- GitHub PAT (direct create link on the signup page — pre-filled scopes)
- AI provider key (DeepSeek recommended — ~$0.27/M tokens — direct link to each provider's key page)

First match in 30 seconds, first digest done in 5-10 minutes.

### Self-host via npm

```bash
npx replen
```

Single command does:
1. Opens your browser to sign up / sign in (Google / GitHub OAuth, passwordless)
2. Walks you through the same 2-key setup
3. Captures auth back into the terminal (browser-callback OAuth, same pattern as `gh auth login`)
4. Wires the [@replen/mcp](https://www.npmjs.com/package/@replen/mcp) server into your Claude Code / Codex config

Point at your own deployment if you self-host the dashboard:

```bash
REPLEN_BASE=https://replen.your-domain.dev npx replen
```

Subcommands: `replen status` · `replen mcp setup` · `replen logout` · `replen --help`.

## What it does

1. **Reads your projects.** Builds a profile per project (purpose, needs, stack, dependencies) so it knows what you'd actually adopt — regardless of project type (library, CLI, app, infra, research code).
2. **Scouts and discovers.** Two passes feed the same triage funnel:
   - **Scouted** — runs derive niche GitHub searches from each project's needs and scout for repos solving exactly that. Catches things trending feeds miss.
   - **Discovered** — sweeps gh-trending tailored to your stack, plus TikTok / Threads / Reddit / HN. The "background hum" of the ecosystem.
3. **Compares each repo against your code.** Bring your own LLM: any OpenAI-compatible endpoint for routine triage, plus an optional second slot (e.g. Anthropic, or a privately-hosted model) for high-sensitivity projects. Verdict per match: **adopt as-is**, **port a specific idea**, or **skip**, with the reasoning written in. Auto-skips established big-co repos. For high-stakes scouted candidates, an optional **source-verification** pass shallow-clones the repo and cross-checks the README's claims against the actual code via a BM25 index — catches the case where a sales-pitch README promises functionality the code doesn't support.
4. **Re-checks what you starred.** Every run re-evaluates your bookmarked general-awareness matches against *other* projects' needs. If something you saved as "interesting for later" fits a different project's need today, it re-surfaces with a **re-checked** pill so you don't lose it to the backlog.
5. **Delivers** three ways:
   - **Web dashboard** at the digest URL: triage, star, hide, search, open handoff PRs. Each match wears a pill — `scouted`, `discovered`, or `re-checked` — so you know how it found you.
   - **HTML email** every morning at the UTC hour you set.
   - **MCP server** that exposes the same data inside Claude Code / Codex / any MCP host, so the agent can answer "what's worth integrating today?" with your codebase in context.
6. **Closes the loop** when you star a keeper: opens a handoff PR in your project's repo with a markdown briefing for the next agent that touches the codebase, and polls the PR status until it's merged → match shows up on `/integrated`.

## What a match looks like

Not a one-liner. Each match is a 400-900 word writeup with the same shape:

> **roboflow/supervision** — high · 87 · gh-trending · 38.7k★ · MIT · pushed 3d ago
>
> Reusable CV building blocks in Python: bounding-box drawing, mask compositing, video sinks, and a small set of trackers (ByteTrack + a Norfair adapter). Active — 11 PRs merged this week.
>
> For *my-cv-project* specifically, there are 3 concrete plug points where it earns its place. Listed in increasing ambition:
>
> 1. **Drop-in replacement for annotations.py.** Your current `BoxAnnotator` / `MaskAnnotator` wrap cv2 in ~180 lines; `supervision.Detections` + `supervision.BoxAnnotator` give the same surface plus label-collision handling and built-in confidence formatting. One file deleted, one import. ~30 min including a smoke test of the demo notebook.
> 2. **Replace trackers/byte.py with supervision.ByteTrack.** You vendored ByteTrack in May; supervision tracks upstream and ships the class-aware tracking fix from October. Drops ~600 lines plus the requirements pin. ~1h to wire up + verify the multi-class regression test passes.
> 3. **Use the video utilities** (`sv.VideoSink`, `sv.get_video_frames_generator`). You call `cv2.VideoCapture` / `VideoWriter` directly across 4 files; supervision wraps them with proper resource management and progress reporting. Less load-bearing than (1) and (2); only if you're already in that code path.
>
> Do (1) first — single PR, isolated blast radius, demonstrates the value before committing to the dependency. (2) only after (1) merges. Skip (3) unless you're already in the video path for something else.

The plug points reference your project's actual files because Replen reads them. The shape is always: intro (what the repo is) → "For PROJECT specifically, N plug points" bridge → numbered plug points naming real files / modules → scoping paragraph telling you the smallest first move.

## Numbers we run on

Engineering numbers we measure, not marketing claims we promise:

- **~$0.09 / user / day** for the routine LLM pipeline on a cheap OpenAI-compatible model with prefix caching warm. Frontier models used only for high-sensitivity projects add ~$0.50-$2 on the days they fire. Hard cap default **$5 / user / day**, configurable on `/settings`.
- **~1-15 s** to build a BM25 source index for a typical OSS repo (walk + tokenise + post-list). Cached per repo against `README sha` so subsequent verifications skip the rebuild.
- **<250 ms** per source-context query against a built index — fast enough that the source-verification pass adds ~30-70 s end-to-end per candidate including the one-time clone.
- **~70 s** typical end-to-end for a per-user pipeline run with no source verification: fetch fan-out, triage, reason, write digest.

Everything in this list is observable in the `digest_runs` table and the structured pipeline logs. We'll add user-outcome metrics (acceptance rate, hit-rate vs gh-trending baseline, time-to-integration) once we've shipped telemetry — until then we won't claim them.

## Workflow

The morning email is just the entry point. The interesting bit is what happens after you find something worth keeping:

```
1. Replen surfaces a match           → in email, dashboard, or via MCP tool
2. You star it                       → click ★, or "use replen to handoff matchId 96"
3. Replen opens a PR in your repo    → a markdown briefing in .replen/handoffs/
4. Your agent picks it up            → Claude Code / Codex reads the briefing,
                                       has full context, proposes the integration
5. You review and merge              → Replen polls PR status, flips to integrated
```

The briefing (committed to your repo, not ours) covers: why this OSS fits *your project specifically*, which files in your codebase to touch, suggested feature-flag rollout, integration risks, what to keep out of scope. Your agent validates against your real codebase and decides. Replen is research + dispatch; never the one writing code into your repo.

Concrete example of a briefing: see [replen.dev](https://replen.dev#the-handoff-loop).

## Architecture

```
─── INGESTION ────────────────────────────────────────────────
  gh-trending (per-user lang slices) ─┐
  TikTok (curated + per-user handles) ├─┐
  Threads (via RSSHub sidecar)        │ │
  Reddit (curated + per-user subs)    │ ├─→  candidates  (sqlite)
  HN (Algolia)                        │ │
  /api/ingest  (bookmarklet / POST)   ─┘
                                        ↓
─── ANALYSIS ─────────────────────────────────────────────────
  per-user pipeline (run-once.ts)
    ├─ resolve user config (decrypt secrets, merge sources)
    ├─ cost guardrail (24h spend vs daily_cost_cap_usd)
    ├─ skip already-actioned repos
    ├─ apply user_feedback weights to source ranking
    ├─ scanRepo (GitHub API)  → safety + readme
    ├─ triage (primary LLM)   → keep/skip decision
    ├─ reason (primary or sensitive LLM by project sensitivity)
    │                         → per-project relevance + writeup
    └─ persist matches  (sqlite)

─── DELIVERY ─────────────────────────────────────────────────
  → email digest          (HTML via configured email provider, project-grouped)
  → /api/mcp/* endpoints  (token-auth, JSON)
  → high-relevance webhook (Slack/Discord/generic, optional)

─── CLIENTS ──────────────────────────────────────────────────
  - Web dashboard (Next.js, Firebase Auth)
  - MCP server  (mcp/, stdio, six tools)
  - Skill       (skills/, triage protocol playbook)
```

## Local dev

```bash
git clone https://github.com/replenhq/replen.git && cd replen
cp .env.example .env   # fill in keys (see below)
npm install
npm run db:generate
npm run db:migrate
npm run dev            # dashboard at http://localhost:3030

# one-shot pipeline run
npm run pipeline:run
```

Required `.env` keys for local:

| key | what for |
|---|---|
| `ENCRYPTION_KEY` | base64 32-byte key for at-rest secret encryption. Generate with `openssl rand -base64 32` |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY_BASE64` | service account for Firebase Auth |
| `LLM_PRIMARY_API_KEY` / `LLM_PRIMARY_BASE_URL` / `LLM_PRIMARY_MODEL` | primary LLM slot, OpenAI-compatible wire format. Works with DeepSeek, OpenAI, Groq, Together, Fireworks, OpenRouter, local llama.cpp / ollama, anything that speaks the OpenAI chat API. Optional shared fallback when no per-user key is set |
| `LLM_SENSITIVE_API_KEY` / `LLM_SENSITIVE_BASE_URL` / `LLM_SENSITIVE_MODEL` | optional second slot used only for projects flagged high-sensitivity. Defaults to Anthropic's `/v1/messages` wire format; set `LLM_SENSITIVE_WIRE_FORMAT=openai-compatible` to route through `/chat/completions` instead |
| `GITHUB_TOKEN` | only used by tests; per-user PATs drive real runs |
| `SYNC_TOKEN` | random string, gates the laptop `/api/sync` CLI |
| `EMAIL_PROVIDER` | `ses` (default, generic SMTP) or `resend`. SMTP uses `SES_SMTP_*` / `SMTP_*` env vars; Resend uses `RESEND_API_KEY`. `EMAIL_FROM_ADDRESS` is required either way |

## Self-host

Runs on any Linux server or your local machine: Node.js + sqlite. Two long-running processes:

- `replen.service`: Next.js dashboard on `127.0.0.1:3030`
- `replen-cron.service`: node-cron scheduler that wakes at your `cron_hour_utc` and runs the pipeline + nightly aging

The included `scripts/deploy.sh` rsyncs the repo to a target host, installs systemd units, and reloads. It is one possible layout; you can swap in any process manager (PM2, supervisord, Docker, a launchd plist on macOS) and any reverse proxy (nginx, Caddy, Traefik) without touching the app. Front it with whatever TLS you already use.

```bash
# populate .env on the remote first (chmod 600); secrets never go through rsync
DEPLOY_HOST=your-ssh-alias \
  ./scripts/deploy.sh
```

Env knobs the deploy script respects (all optional, defaults shown):

| var | default | what |
|---|---|---|
| `DEPLOY_HOST` | `replen-host` | SSH alias for the target host |
| `DEPLOY_DIR` | `/opt/replen` | Remote install dir |
| `DEPLOY_USER` | `ubuntu` | Remote user owning the dir |
| `SERVICE_PREFIX` | `replen` | Systemd unit name prefix |
| `DEPLOY_NGINX_SITE` | `replen.conf` | reverse-proxy sites filename (if you use nginx) |
| `DEPLOY_NGINX_TEMPLATE` | `nginx-replen.conf` | template file inside `scripts/` |
| `DEPLOY_LOG_DIR` | `/var/log/replen` | Remote log dir |

The script excludes `.env`, `node_modules`, `.next`, `data`, and `.git` from rsync, then runs `npm install` + migrations + build remotely. You manage `.env` on the target manually so secrets never transit through your laptop sync.

## Surfaces

### Web dashboard

| Route | Purpose |
|---|---|
| `/` | Today's matches, project-grouped, with star/hide/feedback/handoff actions |
| `/starred` | All starred matches bucketed by handoff state (awaiting / open PR / integrated) |
| `/integrated` | Wall of merged OSS; proof of what actually got shipped |
| `/search` | Full-text across writeups, repo metadata, personal notes |
| `/projects` | Per-project config: sensitivity, LLM provider override, GitHub repo binding |
| `/sources` | Per-user source handles + curated source proposals |
| `/runs` | Run history with cost cards (7d / 30d / avg per match / provider mix), per-source breakdown (candidates → matches → convert% + 👍/👎 net) |
| `/settings` | Credentials, delivery prefs, daily cost cap, webhook, ingest token, bookmarklet + MCP install snippet, language re-detect, maintenance (archive old hidden) |
| `/admin` | Review and approve curated source proposals queued up from any account on the instance |

Keyboard shortcuts on `/`: `j/k` navigate matches, `s` star, `h` hide, `/` focus header search, `?` show hint.

### MCP server (`mcp/`)

Self-contained npm package (`@replen/mcp`) that exposes six tools to Claude Code / Codex / any MCP host:

| Tool | Returns |
|---|---|
| `replen_today` | Recent matches in JSON, filterable by days / relevance / project |
| `replen_search` | Full-text search results |
| `replen_starred` | Starred matches with handoff state |
| `replen_analyze` | Raw README + repo meta + your project profiles for a given owner/name. No LLM call; lets the *host* agent judge fit with your codebase in context |
| `replen_handoff` | Opens a handoff PR for a starred match |
| `replen_feedback` | Records good/bad/star/unstar/hide |

**Install:** `npx replen` (does the OAuth flow + wires this into Claude Code in one command; see Quickstart above).

To install the MCP only (skip the auth flow), or to wire it into a host other than Claude Code, add the entry by hand:

```jsonc
{
  "mcpServers": {
    "replen": {
      "command": "npx",
      "args": ["-y", "@replen/mcp"],
      "env": {
        "DIGEST_BASE_URL": "https://app.replen.dev",
        "DIGEST_TOKEN": "ing_…"
      }
    }
  }
}
```

Token from `/settings` → "Connect Claude Code".

### Skill (`skills/replen-triage/`)

Optional Claude Code skill that wraps the MCP into a morning-triage protocol: fetch today, evaluate the high-relevance ones, propose handoffs, train source weights. Invoke with `/replen-triage`. Installed by copying `skills/replen-triage/` to `~/.claude/skills/`.

The MCP gives the agent **tools** (data access); the skill gives it a **playbook** (when to call what, in what order). Domain-volatility split per [LlamaIndex's skills-vs-MCP article](https://www.llamaindex.ai/blog/skills-vs-mcp-tools-for-agents-when-to-use-what).

## Sources

| Source | Auth | Notes |
|---|---|---|
| gh-trending | none | HTML scrape; pulls a global page + a slice per user-detected language (TypeScript / Python / etc.). The highest-signal source by far |
| TikTok | session-id cookie | Direct API; supports backfill via the separate `Scraper` repo |
| Threads | RSSHub | Optional. Point `THREADS_RSSHUB_BASE` at any [RSSHub](https://docs.rsshub.app) instance (self-host or public) |
| Reddit | none | JSON endpoints, configurable subs |
| HN | none | Algolia API |
| Manual | per-user ingest token | `POST /api/ingest` from a bookmarklet, browser extension, or anywhere else |

Source ranking (for tie-breaking when multiple sources surface the same repo): tiktok > threads > reddit > hn > gh-trending. Weights are scaled per-source by the user's 👍/👎 feedback ratio (smoothed, capped at [0.25, 2.0]), so chronically-bad sources sink in candidate ordering.

## Pipeline (per user, per run)

1. **Cost guardrail**: sum the last 24h of runs; if ≥ `daily_cost_cap_usd`, skip and record a `paused_reason='cost-cap'` row.
2. **runFetchers**: pull candidates from every configured source, dedupe by `(source, source_item_id)`, persist with `userId`.
3. **runAnalysis**:
   - Apply `user_feedback` weights to source ranking.
   - Skip already-actioned repos (starred / hidden / integrated / has handoff PR).
   - For each unique GitHub repo:
     - `scanRepo`: metadata, README, contributor count, postinstall hooks, secret scan.
     - `triage` (primary LLM slot): keep/skip JSON. Skip if not keep.
     - `reasonAboutRepo` (primary or sensitive LLM slot, by project sensitivity): per-project relevance + writeup.
   - Persist a `match` row per (repo, project) pair with a denormalised `source_kind`.
4. **sendDigestEmail**: HTML email grouped by project, with TOC, colour-coded relevance chips, source attribution, click-through to dashboard.
5. **sendHighRelevanceWebhook** (optional): POST to Slack/Discord/generic if any `relevance=high` matches.

Encrypted at rest: PATs, LLM keys, and email-provider creds are stored as AES-256-GCM ciphertext keyed off `ENCRYPTION_KEY` (per-account DEK envelope). Decrypted only in memory during a run.

## Costs

- **LLM:** depends entirely on the providers you wire up. A typical run on a cheap OpenAI-compatible model lands around $0.10 to $0.30/day after prefix-caching kicks in; a frontier model used only for high-sensitivity projects adds ~$0.50 to $2/run on the days it fires.
- **Email:** depends on provider. Both built-in adapters (generic SMTP/SES, Resend) have generous free tiers.
- **Server:** flat, whatever you already pay. Sqlite + Node makes this cheap to run on a small VM or even a Raspberry Pi.
- **MCP / bookmarklet:** no marginal cost; they just query the same DB.

Default daily LLM cap is **$5/user**; configurable on `/settings`.

## Repository layout

```
replen/
├── src/
│   ├── app/                Next.js dashboard + API routes
│   │   └── api/
│   │       ├── mcp/        token-auth MCP endpoints (today/search/starred/analyze/handoff/feedback)
│   │       ├── ingest/     bookmarklet POST endpoint
│   │       ├── sync/       laptop CLI sync
│   │       └── whoami/     auth diagnostic
│   ├── analyzer/           triage + reason + writeup pipeline
│   ├── fetchers/           one module per source
│   ├── scheduler/          cron + per-user pipeline runner
│   ├── scanner/            safety scan (postinstall / secrets / metadata)
│   ├── email/              digest HTML + webhook
│   ├── lib/                crypto, github-pr, github-repo-detect, source-rank, pricing
│   ├── db/                 drizzle schema + migrations
│   └── cli/                one-shot CLIs (sync, backfill, redetect)
├── cli/                    `replen` CLI (the `npx replen` one-liner)
├── mcp/                    @replen/mcp MCP server package
├── skills/                 Claude Code skills
│   └── replen-triage/      morning-triage protocol
├── scripts/                deploy.sh, nginx config, systemd units, plists
└── data/                   sqlite db (gitignored)
```

## License

[FSL-1.1-MIT](LICENSE) — Functional Source License with a 2-year MIT future grant. In plain English:

- **You can self-host Replen for your own use** (internal, personal, your company's internal tooling). Free, no asterisks.
- **You can read, modify, and redistribute the source code** for any non-competing purpose.
- **You can't run Replen as a commercial service that competes with us** (e.g. offering "Hosted Replen" to other people) until the 2-year window expires for that version.
- **After 2 years, each version auto-converts to MIT** — same permissive licence as before, just delayed.

The FSL terms apply to all commits from `1361647` onward (2026-05-17). The public mirror at [replenhq/replen](https://github.com/replenhq/replen) is FSL-1.1-MIT from its first commit.

If you want to use Replen in a way that might cross the "competing use" line, get in touch via [replen.dev](https://replen.dev) and we'll sort out a commercial licence.

## Credits

Replen was built by [@nsokin](https://github.com/nsokin) and the community.

- [replen.dev](https://replen.dev) — site
- [docs.replen.dev](https://docs.replen.dev) — docs
- [app.replen.dev](https://app.replen.dev) — hosted dashboard
- [@replenhq](https://github.com/replenhq) — GitHub org

