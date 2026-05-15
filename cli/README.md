# replen

One-command setup for [replen](https://replen.dev) — daily personalised OSS discovery.

```bash
npx replen
```

That single command:
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

MIT — see [LICENSE](./LICENSE).
