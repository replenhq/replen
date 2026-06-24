# replen

**Make your AI coding tools aware of everything your code depends on, implements, and builds on.** One command, no API keys.

```bash
npx replen
```

Claude Code, Codex, Cursor already know your code. Replen tells them what's happening *outside* it. The match decision happens *inside your AI tool's session* on your subscription tokens. Your code stays on your laptop. Replen never sees it.

Four lenses, all surfaced the same calm way — quietly, in your AI tool's next reply, only when there's something real:

- **🔭 OSS repos** — a new library that replaces code you maintain, a pattern worth porting, a dead dep to swap.
- **📦 Your stack** — a release in a dependency you actually use (`next`, `openai`, `prisma`, `viem`, … matched against your manifest).
- **📜 Standards you implement** — EIP/ERC, TC39, and Chrome-deprecation changes matched to what your code touches.
- **🩺 Upstream health** — a dep gone stale/archived, a hot bug others hit in your deps, or an incident on a service you use.

One discipline throughout: **silence beats a weak match** — if nothing clears the bar, Replen says nothing.

## What `npx replen` does

In 60 seconds, the one-liner:

1. Opens your browser to sign in (Google or GitHub via Firebase)
2. Captures the auth back into the terminal (browser-callback flow, like `gh auth login`)
3. Scans your local repos under `~/github/`, `~/code/`, `~/projects/` for git repos
4. Auto-extracts tags from each (`package.json` deps, `pyproject.toml`, etc.)
5. Registers them with Replen as your projects (no GitHub PAT needed)
6. Wires the [@replen/mcp](https://www.npmjs.com/package/@replen/mcp) server into your Claude Code / Codex config
7. Installs the `/replen` skill into `~/.claude/skills/`
8. Injects a small "Replen integration" section into each project's `CLAUDE.md` + `AGENTS.md`

**What you do not provide:**
- ❌ OpenAI / Anthropic API key — your AI tool's subscription handles all reasoning
- ❌ GitHub PAT — optional, only if you want server-side handoff PRs later
- ❌ Per-project setup — auto-discovered from your local filesystem

Open Claude Code (or Codex) in any of your tracked repos and start working normally. When Replen has matches, your AI tool mentions them after answering your first message. Silent on quiet days.

## Subcommands

```bash
npx replen                 # sign in + setup (the one-liner above)
npx replen status          # show current config
npx replen sync-projects   # re-scan local repos for new GitHub remotes;
                           #   run after cloning a new repo
npx replen inject [-y]     # re-inject the "Replen integration" section
                           #   into every CLAUDE.md + AGENTS.md
npx replen mcp setup       # re-wire MCP using saved auth
npx replen logout          # forget saved auth (rotate on /settings to revoke)
```

## Plain-shell usage (no Claude Code / Codex needed)

```bash
npx replen check-new            # one-shot: any new matches since you last
                                # engaged? (used by the SessionStart hook)
npx replen feed                 # show recent matches (default 2 days)
npx replen watch                # keep a terminal open — rings the bell when
                                # a new match lands. Default poll 5min.
npx replen search <query>       # full-text search past matches
npx replen starred              # starred matches + handoff PR status
npx replen handoff <matchId>    # open the handoff PR for a starred match
npx replen run                  # trigger a fresh pipeline run (hosted-tier only)
npx replen progress             # tail the run live; exits when done
```

Every data command accepts `--json` for scripting.

## How matches surface in Claude Code / Codex

Three layers, defence-in-depth — at least one will fire:

1. **SessionStart hook** runs `npx replen check-new --hook` at the start of every Claude Code session. If there's anything new, the JSON output appears in the agent's opening context.
2. **MCP tool** `replen_match` is exposed to the agent at all times. The instructions in `CLAUDE.md` tell it to call this once early in each session (it returns the footnote + the candidate inventory).
3. **CLAUDE.md / AGENTS.md instruction** (idempotent, marker-versioned) is injected into every tracked repo on setup. This is the most reliable layer — survives Claude Code version churn.

Calm-cadence by design: most days are silent. 1-3 actionable matches a month per project.

## Self-host

Pointing at your own Replen instance:

```bash
REPLEN_BASE=https://replen.mydomain.dev npx replen
```

## How the auth works

1. CLI generates a random state token and picks a free port (~38xxx)
2. Starts a local HTTP server on `127.0.0.1:<port>/callback`
3. Opens your browser to `https://app.replen.dev/cli-auth?port=<port>&state=<state>`
4. You sign in (Firebase Auth) and click "Authorize CLI on this computer"
5. Your browser navigates to `http://127.0.0.1:<port>/callback?token=<ing_...>&state=<state>`
6. CLI validates state, saves the token to `~/.replen/config.json` (mode 0600)
7. CLI continues and writes the MCP config into `~/.claude.json`

The token never transits anything other than your browser ↔ localhost ↔ disk. The Replen backend only sees it on subsequent MCP / API requests.

## Revoke

Rotate the ingest token on the [/settings](https://app.replen.dev/settings) page. The old one stops working immediately. Then re-run `npx replen` to get a fresh one.

## License

MIT - see [LICENSE](./LICENSE).
