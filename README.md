<div align="center">
  <img src="logo.svg" width="64" alt="replen">
  <h1>replen</h1>
  <p><strong>Smart AI Development workflows</strong></p>
  <p>The AI that asks: <em>"can we do this better?"</em></p>

  <p>
    <a href="https://www.npmjs.com/package/replen"><img src="https://img.shields.io/npm/v/replen?style=flat-square&color=d97706" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/replen"><img src="https://img.shields.io/npm/dm/replen?style=flat-square&color=d97706" alt="npm downloads"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
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

Claude Code, Codex, Cursor — they wait for you to ask. None of them look at your codebase on their own and ask *"what could we be doing better here? what are others doing we could learn from?"*

Replen does. Every morning, on every project, against the live ecosystem. For each new repo in your niche, it does the comparative work a senior dev would: read it, compare against your codebase, decide — **adopt as-is**, **port a specific idea**, or **skip** — with the reasoning written in. The keepers come with a PR-ready briefing your AI coding workflow (Claude Code, Codex, whichever) picks up and integrates.

The training-cutoff problem makes this more urgent — every LLM has a date past which it just doesn't know, and your AI tool will happily confabulate around the gap. But the deeper reason is simpler: good engineering means asking *"can we do this better?"* — continuously. Replen runs that loop for you.

Pulls from gh-trending, TikTok, Threads, Reddit, HN — plus niche-scouted GitHub searches tuned to your project's domain. Multi-tenant, encrypted at rest, bring-your-own-keys. Hosted at [app.replen.dev](https://app.replen.dev) — or self-host (no Docker required).

## Quickstart

```bash
npx replen
```

That single command:
1. Opens your browser to sign up / sign in
2. Captures auth back into the terminal (browser-callback OAuth, same pattern as `gh auth login`)
3. Wires the [@replen/mcp](https://www.npmjs.com/package/@replen/mcp) server into your Claude Code / Codex config

You're triaging by tomorrow morning. No token-paste, no JSON-fiddling.

For self-host targets:

```bash
REPLEN_BASE=https://replen.your-domain.dev npx replen
```

Subcommands: `replen status` · `replen mcp setup` · `replen logout` · `replen --help`.

## What it does

1. **Characterises your projects.** Reads each project's docs (README, CLAUDE.md, manifests) to build a profile of what you're building — stack, niche, purpose, use cases — regardless of project type (library, CLI, app, infra, research code, etc.).
2. **Ingests from the ecosystem.** gh-trending pages tailored to your stack, TikTok / Threads handles, Reddit subs, HN, plus niche-scouted GitHub searches derived from your project profile. Catches things trending feeds miss.
3. **Compares each new repo against your code.** DeepSeek by default (~$0.10–$0.30/day), Anthropic opt-in per-project for sensitive codebases. Verdict per match: **adopt as-is**, **port a specific idea**, or **skip** — with the reasoning written in. Auto-skips established big-co repos.
4. **Delivers** three ways:
   - **Web dashboard** at the digest URL — triage, star, hide, search, open handoff PRs.
   - **HTML email** every morning at the UTC hour you set.
   - **MCP server** that exposes the same data inside Claude Code / Codex / any MCP host, so the agent can answer "what's worth integrating today?" with your codebase in context.
5. **Closes the loop** when you star a keeper: opens a handoff PR in your project's repo with a markdown briefing for the next agent that touches the codebase, and polls the PR status until it's merged → match shows up on `/integrated`.

## Workflow

The morning email is just the entry point. The interesting bit is what happens after you find something worth keeping:

```
1. replen surfaces a match           — in email, dashboard, or via MCP tool
2. You star it                       — click ★, or "use replen to handoff matchId 96"
3. replen opens a PR in your repo    — a markdown briefing in .replen/handoffs/
4. Your agent picks it up            — Claude Code / Codex reads the briefing,
                                       has full context, proposes the integration
5. You review and merge              — replen polls PR status, flips to integrated
```

The briefing — committed to your repo, not ours — covers: why this OSS fits *your project specifically*, which files in your codebase to touch, suggested feature-flag rollout, integration risks, what to keep out of scope. Your agent validates against your real codebase and decides. replen is research + dispatch; never the one writing code into your repo.

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
    ├─ triage (DeepSeek)      → keep/skip decision
    ├─ reason (DeepSeek/Anthropic by project sensitivity)
    │                         → per-project relevance + writeup
    └─ persist matches  (sqlite)

─── DELIVERY ─────────────────────────────────────────────────
  → email digest          (HTML via SES, project-grouped)
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
| `DEEPSEEK_API_KEY` | optional shared fallback (per-user keys override) |
| `ANTHROPIC_API_KEY` | same |
| `GITHUB_TOKEN` | only used by tests; per-user PATs drive real runs |
| `SYNC_TOKEN` | random string, gates the laptop `/api/sync` CLI |
| `EMAIL_FROM_ADDRESS` / `SES_SMTP_*` | Amazon SES creds for email delivery |

## Production deployment

The VPS uses systemd + nginx + certbot. Two services run:

- `replen.service` — Next.js dashboard on `127.0.0.1:3030`
- `replen-cron.service` — node-cron scheduler that wakes at the user's `cron_hour_utc` and runs the per-user pipeline + nightly aging

```bash
# from your laptop, populate .env on the remote first (chmod 600)
DEPLOY_HOST=your-ssh-alias \
  ./scripts/deploy.sh
```

Env knobs the deploy script respects (all optional, defaults shown):

| var | default | what |
|---|---|---|
| `DEPLOY_HOST` | `replen-host` | SSH alias for your VPS |
| `DEPLOY_DIR` | `/opt/replen` | Remote install dir |
| `DEPLOY_USER` | `ubuntu` | Remote user owning the dir |
| `SERVICE_PREFIX` | `replen` | Systemd unit name prefix |
| `DEPLOY_NGINX_SITE` | `replen.conf` | nginx sites-* filename |
| `DEPLOY_NGINX_TEMPLATE` | `nginx-replen.conf` | template file inside `scripts/` |
| `DEPLOY_LOG_DIR` | `/var/log/replen` | Remote log dir |

The script: `rsync`s the repo (excluding `.env`, `node_modules`, `.next`, `data`, `.git`), runs `npm install` + migrations + build, installs the systemd units + nginx config, reloads everything. You manage `.env` on the server manually so secrets never transit through your laptop sync.

## Onboarding a new user

1. User signs in to the dashboard via Firebase Auth.
2. **Welcome wizard** (`/welcome`) walks them through four steps:
   - Save a GitHub fine-grained PAT (one token: Contents R+W, Pull requests R+W, Metadata R). The wizard auto-detects their project repos *and* their primary languages from this PAT.
   - Email destination + UTC cron hour.
   - Confirm detected projects + curated sources.
   - Fire the first pipeline run.
3. From then on, `/settings` is where they manage everything: source handles, cost cap, webhook URL, MCP / ingest token rotation, language re-detection.

## Surfaces

### Web dashboard

| Route | Purpose |
|---|---|
| `/` | Today's matches, project-grouped, with star/hide/feedback/handoff actions |
| `/starred` | All starred matches bucketed by handoff state (awaiting / open PR / integrated) |
| `/integrated` | Wall of merged OSS — proof of what actually got shipped |
| `/search` | Full-text across writeups, repo metadata, personal notes |
| `/projects` | Per-project config: sensitivity, LLM provider override, GitHub repo binding |
| `/sources` | Per-user source handles + curated source proposals |
| `/runs` | Run history with cost cards (7d / 30d / avg/match / provider mix), per-source breakdown (candidates → matches → convert% + 👍/👎 net) |
| `/settings` | Credentials, delivery prefs, daily cost cap, webhook, ingest token, bookmarklet + MCP install snippet, language re-detect, maintenance (archive old hidden) |
| `/admin` | (admin only) Manage users, grant shared-LLM access, review source proposals |

Keyboard shortcuts on `/`: `j/k` navigate matches, `s` star, `h` hide, `/` focus header search, `?` show hint.

### MCP server (`mcp/`)

Self-contained npm package (`@replen/mcp`) that exposes six tools to Claude Code / Codex / any MCP host:

| Tool | Returns |
|---|---|
| `digest_today` | Recent matches in JSON, filterable by days / relevance / project |
| `digest_search` | Full-text search results |
| `digest_starred` | Starred matches with handoff state |
| `digest_analyze_repo` | Raw README + repo meta + your project profiles for a given owner/name — no LLM call, lets the *host* agent judge fit with your codebase in context |
| `digest_create_handoff` | Opens a handoff PR for a starred match |
| `digest_feedback` | Records good/bad/star/unstar/hide |

**Install:** `npx replen` (does the OAuth flow + wires this into Claude Code in one command — see Quickstart above).

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

Optional Claude Code skill that wraps the MCP into a morning-triage protocol — fetch today, evaluate the high-relevance ones, propose handoffs, train source weights. Invoke with `/replen-triage`. Installed by copying `skills/replen-triage/` to `~/.claude/skills/`.

The MCP gives the agent **tools** (data access); the skill gives it a **playbook** (when to call what, in what order). Domain-volatility split per [LlamaIndex's skills-vs-MCP article](https://www.llamaindex.ai/blog/skills-vs-mcp-tools-for-agents-when-to-use-what).

## Sources

| Source | Auth | Notes |
|---|---|---|
| gh-trending | none | HTML scrape; pulls a global page + a slice per user-detected language (TypeScript / Python / etc.) — the highest-signal source by far |
| TikTok | session-id cookie | Direct API; supports backfill via the separate `Scraper` repo |
| Threads | RSSHub | Optional — point `THREADS_RSSHUB_BASE` at any [RSSHub](https://docs.rsshub.app) instance (self-host or public) |
| Reddit | none | JSON endpoints, configurable subs |
| HN | none | Algolia API |
| Manual | per-user ingest token | `POST /api/ingest` from a bookmarklet, browser extension, or anywhere else |

Source ranking (for tie-breaking when multiple sources surface the same repo): tiktok > threads > reddit > hn > gh-trending. Weights are scaled per-source by the user's 👍/👎 feedback ratio (smoothed, capped at [0.25, 2.0]), so chronically-bad sources sink in candidate ordering.

## Pipeline (per user, per run)

1. **Cost guardrail** — sum the last 24h of runs; if ≥ `daily_cost_cap_usd`, skip and record a `paused_reason='cost-cap'` row.
2. **runFetchers** — pull candidates from every configured source, dedupe by `(source, source_item_id)`, persist with `userId`.
3. **runAnalysis**:
   - Apply `user_feedback` weights to source ranking.
   - Skip already-actioned repos (starred / hidden / integrated / has handoff PR).
   - For each unique GitHub repo:
     - `scanRepo` — metadata, README, contributor count, postinstall hooks, secret scan.
     - `triage` (DeepSeek-chat) — keep/skip JSON. Skip if not keep.
     - `reasonAboutRepo` (DeepSeek or Anthropic by project sensitivity) — per-project relevance + writeup.
   - Persist a `match` row per (repo, project) pair with a denormalised `source_kind`.
4. **sendDigestEmail** — HTML email grouped by project, with TOC, colour-coded relevance chips, source attribution, click-through to dashboard.
5. **sendHighRelevanceWebhook** (optional) — POST to Slack/Discord/generic if any `relevance=high` matches.

Encrypted at rest: PATs, LLM keys (DeepSeek + Anthropic), and SES creds are stored as `enc:v1:<iv>:<tag>:<ciphertext>` using AES-256-GCM keyed off `ENCRYPTION_KEY`. Decrypted only in memory during a run.

## Costs

- **DeepSeek:** ~$0.10–$0.30 per typical daily run after their prefix-cache kicks in.
- **Anthropic:** only used for high-sensitivity projects. ~$0.50–$2 per run if any.
- **SES:** free tier covers ~62k emails/month from EC2; ~$0.10/1k otherwise.
- **VPS:** flat, whatever you already pay.
- **MCP / bookmarklet:** no marginal cost — they just query the same DB.

Default daily cap is **$5/user**; configurable on `/settings`.

## What's still stubbed / known gaps

- **Tenant-isolation test** — multi-tenant queries look clean by audit but no automated guard yet.
- **HTML triage artifacts** — the skill writes to `~/replen/reports/`; pending validation as to whether this beats terminal markdown for daily use.
- **Aging policy automation** — `archiveOldHidden(90)` is manual via /settings; could run nightly.

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
