# replen

**Smarter AI Development workflows.** One-command setup for [replen](https://replen.dev) - the AI that asks *"can we do this better?"* on your codebase. Calm cadence: 1-3 actionable matches a month, not a daily feed.

```bash
npx replen
```

While your AI coding tool waits for prompts, replen reads your code against the ecosystem and surfaces drop-in libraries, ideas to port, and patterns to learn from. A proactive layer for your AI coding workflow.

The single command above:
1. Opens your browser to sign in / sign up at `app.replen.dev`
2. Captures the auth back into the terminal (browser-callback flow, like `gh auth login`)
3. Wires the [@replen/mcp](https://www.npmjs.com/package/@replen/mcp) server into your Claude Code / Codex config

Same flow that `claude` itself uses for auth.

## Subcommands

```bash
npx replen              # sign in + setup
npx replen status       # show current config
npx replen mcp setup    # re-wire MCP using saved auth
npx replen logout       # forget saved auth (token stays valid; rotate on /settings to revoke)
```

## Plain-shell usage (no Claude Code / Codex needed)

```bash
npx replen run                  # trigger a pipeline run
npx replen progress             # tail the run live; exits when done
npx replen check-new            # one-shot: any new actionable matches since
                                # you last engaged? (also runs automatically
                                # at every Claude Code session start)
npx replen feed                 # show recent matches (default 2 days)
npx replen watch                # keep a terminal open — rings the bell when
                                # a new match lands. Default poll 5min.
npx replen search <query>       # full-text search past matches
npx replen starred              # starred matches + handoff PR status
npx replen handoff <matchId>    # open the handoff PR for a starred match
```

`watch` is the calm-utility companion: leave it running in a `tmux` pane and forget about it. The first poll establishes a baseline; existing matches don't ring.

`check-new` is wired into Claude Code automatically by `npx replen` setup — it installs a SessionStart hook that runs `npx replen check-new --hook` whenever you open Claude Code. The hook is silent unless there's something new since you last engaged (across dashboard, email, or a prior session); when there is, the new matches show up in the agent's opening context without you having to ask. Calm-cadence by design.

Every data command accepts `--json` for scripting.

## Self-host

Pointing at your own replen instance:

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

The token never transits anything other than your browser ↔ localhost ↔ disk. The replen backend only sees it on subsequent MCP / API requests.

## Revoke

Rotate the ingest token on the [/settings](https://app.replen.dev/settings) page. The old one stops working immediately. Then re-run `npx replen` to get a fresh one.

## License

MIT - see [LICENSE](./LICENSE).
