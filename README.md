<div align="center">
  <img src="logo.svg" width="120" alt="Replen">
  <h1>Replen</h1>
  <p><strong>Smarter AI Development workflows</strong></p>
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

**Your AI coding tools, aware of everything your code depends on, implements, and builds on.**

Claude Code, Codex, and Cursor already understand your code. Replen understands what it *does* — it maps each project to its technical capabilities (computer vision, geospatial, market-making, whatever you're building) and watches the wider ecosystem for things that fit: a library that fills a capability you have, a new release in a dependency you use, a security advisory in your stack, a standard you implement changing, an upstream going dark.

**The matching is the product.** Anyone can list trending repos — that part is commodity. Replen scores every candidate against *your* capabilities, and against a cross-user capability graph that gets sharper with every project it sees. The judgment call happens inside your AI tool's session, against your real code; your code never leaves your machine.

1–3 useful suggestions a month, by design. Most days, nothing — that's the point. When something real lands, your AI tool mentions it next time you open the repo: *"by the way — `opencv/opencv` could help with your computer-vision pipeline. Want the full review?"*

## Quickstart

```bash
npx replen
```

That single command, in 60 seconds:

1. Opens your browser to sign in (Google or GitHub via Firebase)
2. Scans your local repos under `~/github/`, `~/code/`, `~/projects/` for git repos
3. Auto-extracts tags from each (`package.json` deps, `pyproject.toml`, etc.) — no GitHub PAT needed
4. Registers them with Replen as your projects
5. Installs the [@replen/mcp](https://www.npmjs.com/package/@replen/mcp) server into your Claude Code / Codex config
6. Installs the `/replen-match` skill in `~/.claude/skills/`
7. Injects a small "Replen integration" section into each project's `CLAUDE.md` + `AGENTS.md`

**What you do not provide:**
- ❌ OpenAI / Anthropic / DeepSeek API key — your AI tool's subscription handles reasoning
- ❌ GitHub PAT — optional, only needed if you want server-side handoff PRs
- ❌ Manual project setup — auto-discovered from your local filesystem
- ❌ Per-project tag config — auto-extracted from manifests

Open Claude Code (or Codex) in any of your tracked repos and start working normally. Replen mentions matches in your AI's response when there are any. Silent on quiet days.

For self-host: `REPLEN_BASE=https://replen.your-domain.dev npx replen`.

Subcommands: `replen sync-projects` · `replen status` · `replen inject` · `replen mcp setup` · `replen logout` · `replen --help`.

## What it does

1. **Understands what your code does, then matches by capability.** Replen extracts each project's technical capabilities from its docs and dependencies — computer vision, geospatial, market-making, realtime streaming — and scores candidates against *those*, not a generic trending list. Candidates come from a shared, capability-indexed library catalogue plus targeted search; the matching is what makes a suggestion fit your repo. Mechanical and cheap — no per-candidate LLM.

2. **Tells your AI tool when something landed.** A small session-start check returns up to 5 candidates per project. When you next open Claude Code / Codex in a tracked repo, your AI tool sees the candidate list in its opening context and mentions it after answering your first message. Silent on the days nothing is queued.

3. **The agent triages in-session.** Using your subscription tokens (no API key needed), your AI tool: WebFetches each candidate's README, greps your local source for related code, forms a verdict (adopt / port / skip) with score + effort estimate, and composes a writeup grounded in concrete file references in *your* repo. All reasoning runs on your AI tool's subscription — Replen has no LLM provider on the server side, so there's nothing to bill and no API key to give us.

4. **You act on the keepers.** Star / hide / handoff PR — captured server-side via `replen_state`; the agent never re-surfaces what you've actioned. The PR-creation step uses your existing `gh auth` (no Replen-stored credentials).

## What Replen watches

Replen began by matching new OSS repos to your code. It now watches five lenses — everything your code depends on, implements, or builds on — each scored against your project's *capabilities*, not a keyword list. They surface the same calm way: quietly, in your AI tool's next reply, only when there's something real.

- **🔭 Libraries that fit a capability you have.** Open-source projects scored against what your repo actually does — a CV library for your vision pipeline, a backtesting framework for your trading bot, a library that replaces 200 lines you maintain. Drawn from a cross-user capability catalogue that sharpens with every project. *(See the example below.)*

- **🔒 Security in your stack — known advisories.** A new CVE in a dependency you use, mapped from your manifest to the OSS advisory database, gated to what you'd actually act on.
  > *By the way — a security advisory affects a dependency you use: `drizzle-orm` (CVE-2026-39356, HIGH — SQL injection).*

- **📦 Your stack — dependency releases.** When a vendor you actually depend on ships, you hear about it — `next`, `openai`, `prisma`, `viem`, `stripe`-class SDKs and ~20 more, matched against your `package.json` / lockfile so it's *your* dependencies, not a firehose.
  > *By the way — a dependency you use just shipped: OpenAI SDK v6.39.0.*

- **📜 The standards you implement — spec changes.** EIPs/ERCs for web3 code, TC39 stage advancements for JS/TS, Chrome Platform Status deprecations for frontends — matched to the standards your project actually touches.
  > *By the way — a standard your code implements just changed: ERC-5516.*

- **🩺 The health of what you build on — upstream risk.** A direct dependency gone stale or archived, a high-engagement bug others are hitting in one of your deps, or an active incident on a managed service you use (Vercel, Supabase, Cloudflare, …).
  > *By the way — an upstream you depend on needs attention: `request` looks dead (no push in 654 days).*

Everything runs through one discipline: **silence beats a weak match.** If nothing clears the relevance bar, Replen says nothing — no daily "by the way" noise. A brand-new project gets a wide first look (months of history); after that, the last week. And the inventory learns from how people triage: a candidate enough users judge rubbish stops being shown to *anyone*, while one that proves useful for a project like yours can surface to you too — repo identity and aggregate signal only, never your code or anyone else's.

Manage which repos Replen watches — inclusion, tags, owner — at **[app.replen.dev/projects](https://app.replen.dev/projects)**.

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

The plug points reference your project's actual files because *your AI tool reads them in-session*. The shape is always: intro (what the repo is) → "For PROJECT specifically, N plug points" bridge → numbered plug points naming real files / modules → scoping paragraph telling you the smallest first move.

## Numbers we run on

Engineering numbers we measure, not marketing claims we promise.

- **$0 to use.** No Replen-side LLM call means nothing to bill. All reasoning runs in your Claude Code / Codex session on the subscription tokens you already pay for; your AI tool's normal rate limits apply.
- **1-3 actionable matches per month per project.** The target cadence. Server-side eligibility filters prune 60-80% of the daily firehose; the per-project diversity cap (max 6 visible / project / window) prevents noisy weeks from drowning the signal.
- **~50 ms** for the session-start `replen_check_new` ping: cursor-based, so it only sees what's new since the last call.
- **~20-90 s** for in-session triage of one candidate — the agent fetches the README, greps your code, writes the verdict. Multiple candidates run sequentially in the same conversation.

## Workflow

```
1. Server-side fetcher pulls candidates           → gh-trending, gh-targeted, ossinsight,
                                                    Threads, Reddit, HN; eligibility filter
                                                    drops aggregators / archived / dups
2. You open Claude Code / Codex in a repo         → SessionStart hook + CLAUDE.md instruction
                                                    surfaces "N new matches" in opening context
3. Your AI tool mentions them after your prompt   → "by the way, 2 new Replen matches landed..."
4. You ask for triage                             → "show me the top one"
5. Agent invokes the /replen-match skill          → WebFetches READMEs, greps your local code,
                                                    forms verdict (adopt/port/skip) with score
6. You star, hide, or hand off                    → replen_state captures it server-side;
                                                    agent never re-surfaces what you actioned
7. Optional: open a handoff PR                    → markdown briefing in .replen/handoffs/;
                                                    next agent reads it, proposes the diff
```

The handoff briefing (committed to your repo, not ours) covers: why this OSS fits *your project specifically*, which files in your codebase to touch, suggested feature-flag rollout, integration risks, what to keep out of scope. Replen is research + dispatch; never the one writing code into your repo.

Concrete example of a briefing: see [replen.dev](https://replen.dev#the-handoff-loop).

## Architecture

```
─── INGESTION (server-side, mechanical, no LLM) ──────────────
  gh-trending (per-user lang slices) ─┐
  TikTok (curated + per-user handles) ├─┐
  Threads (via RSSHub sidecar)        │ │
  Reddit (curated + per-user subs)    │ ├─→  candidates  (sqlite)
  HN (Algolia)                        │ │     + eligibility filter
  ossinsight (24-month long-tail)     │ │     (drop archived /
  /api/ingest (bookmarklet / POST)   -─┘      aggregator / dup)
                                        ↓
─── ELIGIBILITY + RANKING (mechanical) ───────────────────────
    ├─ dedup across sources (gh-trending + Reddit often overlap)
    ├─ apply user_feedback weights to source ranking
    ├─ per-project diversity cap (max 6 visible / project / window)
    └─ persist with discovery mode tag (scouted / discovered / re-checked)
                                        ↓
─── DELIVERY ─────────────────────────────────────────────────
  → @replen/mcp (stdio, 13 tools)
       ↑    replen_check_new → "N new" surfaced in session
       │    replen_match     → curated inventory scoped to open repo
       │    replen_state     → star / hide / handoff captured
       │
  ┌────┴─────────────────────────────────────────────────────┐
  │  /replen-match skill (Claude Code playbook)              │
  │    - WebFetches each candidate's README                  │
  │    - Greps the user's local code                         │
  │    - Forms verdict (adopt / port / skip) + writeup       │
  │    - All reasoning on user's subscription tokens         │
  │    - Replen never sees source code                       │
  └──────────────────────────────────────────────────────────┘
  → SessionStart hook       (npx replen check-new --hook, ~50ms)
  → handoff PR mechanism    (GitHub REST API, optional PAT)
  → high-relevance webhook  (Slack / Discord, optional)
  → Webapp                  (Next.js, Firebase Auth — settings + history viewer)
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
| `ENCRYPTION_KEY` | base64 32-byte key for at-rest secret encryption (used for the optional GitHub PAT). Generate with `openssl rand -base64 32` |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY_BASE64` | service account for Firebase Auth |
| `GITHUB_TOKEN` | only used by tests; user PATs (optional, for handoff PRs) drive real runs |
| `SYNC_TOKEN` | random string, gates the laptop `/api/sync` CLI |

No LLM provider keys are required — reasoning happens client-side in the user's AI tool session, not on the server. See `.env.example` for legacy / opt-in extras (e.g. webhooks).

## Self-host

Runs on any Linux server or your local machine: Node.js + sqlite. Two long-running processes:

- `replen.service`: Next.js webapp (settings + history) on `127.0.0.1:3030`
- `replen-cron.service`: node-cron scheduler that periodically fetches source feeds, applies the eligibility filter, and updates the candidate inventory. Mechanical work — no LLM calls.

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

The product is the **skill + MCP**, running inside your Claude Code / Codex session. The webapp is a settings UI for configuring the skill/MCP and a history viewer for browsing what surfaced over time — optional, the skill works whether you ever sign in or not.

### Skill (`skills/replen-match/`)

`/replen-match` is the Claude Code skill that runs in-session triage: list new candidates via the MCP, WebFetch each candidate's README, grep your local code, form a per-candidate verdict (adopt / port / skip) with a writeup grounded in real file paths in *your* repo. Invoke explicitly with `/replen-match`, or let the agent invoke it automatically when the SessionStart hook surfaces "N new matches." `npx replen` installs it into `~/.claude/skills/` for you.

The MCP gives the agent **tools** (data access); the skill gives it a **playbook** (when to call what, in what order, how to write the verdict). Domain-volatility split per [LlamaIndex's skills-vs-MCP article](https://www.llamaindex.ai/blog/skills-vs-mcp-tools-for-agents-when-to-use-what).

### MCP server (`mcp/`)

Self-contained npm package (`@replen/mcp`) that exposes thirteen tools to Claude Code / Codex / any MCP host. Grouped by role:

| Role | Tool | Returns |
|---|---|---|
| **Triage flow** | `replen_check_new` | Have any new high/medium matches landed since last session? Cheap (~50ms). Bumps a cursor so the next call only sees what's new |
| | `replen_match` | Today's curated inventory scoped to the open repo. Returns candidates + `whyShortlisted` line; the skill triages each against the local codebase |
| | `replen_state` | Capture user actions: star / unstar / hide / handoff |
| | `replen_record_triage` | Persist the agent's verdict (adopt / port / skip + score + effort) back to Replen |
| **Inspection** | `replen_today` | Recent matches in JSON, filterable by days / relevance / project |
| | `replen_search` | Full-text search across writeups, repo metadata, notes |
| | `replen_starred` | Starred matches with handoff state |
| | `replen_analyze` | Raw README + repo meta + your project profiles for a given owner/name. No LLM call; lets the *host* agent judge fit with your codebase in context |
| **Actions** | `replen_handoff` | Opens a handoff PR for a starred match |
| | `replen_feedback` | Records good / bad on a source (retrains source ranking) |
| **Ingest control** | `replen_run` | Triggers a fresh server-side ingest run (source fetch + eligibility filter) without opening the dashboard |
| | `replen_status` | Polls the current ingest run (in-flight or finished); reports candidate counts and any pause reason |
| **Discovery** | `replen_help` | Tool-discovery list; useful when bootstrapping the connection |

**Install:** `npx replen` (OAuth flow + wires this into Claude Code in one command; see Quickstart above).

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

### Webapp (optional)

Settings UI for the skill/MCP and a history viewer for past matches. Use it when you want to tweak per-project tags, browse what surfaced over the last month, or check on a handoff PR's status. Everything else surfaces in-session — you can ignore the webapp entirely if you live in Claude Code.

| Route | Purpose |
|---|---|
| `/` | History view: past matches project-grouped, with star/hide/handoff state |
| `/starred` | All starred matches bucketed by handoff state (awaiting / open PR / integrated) |
| `/integrated` | Wall of merged OSS; proof of what actually got shipped |
| `/search` | Full-text across writeups, repo metadata, personal notes |
| `/projects` | Per-project settings: sensitivity, GitHub repo binding, per-project tags + filter-mode |
| `/sources` | Per-user source handles + curated source proposals |
| `/runs` | Ingest run history; per-source breakdown (candidates surfaced + 👍/👎 net) |
| `/settings` | Ingest token, MCP install snippet, bookmarklet, webhook (optional), maintenance |
| `/admin` | Review and approve curated source proposals queued up from any account on the instance |

Keyboard shortcuts on `/`: `j/k` navigate matches, `s` star, `h` hide, `/` focus header search, `?` show hint.

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

## Server-side pipeline (per user, per run)

The server runs a small periodic job (cron, configurable interval) that maintains the candidate inventory. Mechanical work — no LLM calls anywhere on the server side.

1. **runFetchers**: pull candidates from every configured source, dedupe by `(source, source_item_id)`, persist with `userId`.
2. **eligibility filter**: drop aggregators, archived deps, language mismatches, cross-source duplicates. Tags candidates at insert with language + topics + repo-shape.
3. **rank**: apply `user_feedback` weights to source ranking (per-source 👍/👎 smoothed).
4. **diversity cap**: enforce per-project visible cap (default 6 / project / window) so noisy weeks don't drown the signal.
5. **sendHighRelevanceWebhook** (optional): POST to Slack/Discord/generic if any new `relevance=high` matches.

The agent's verdicts (adopt / port / skip) come in later, via `replen_record_triage` from your AI tool's in-session triage. They're persisted alongside the candidates for browsing on the webapp.

Encrypted at rest (AES-256-GCM, per-account DEK envelope, keyed off `ENCRYPTION_KEY`): the optional user PAT used for handoff PRs, and the optional webhook URL. No LLM keys are stored because none are needed.

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
│   └── replen-match/       in-session match triage protocol
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

