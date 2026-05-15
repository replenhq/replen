# @replen/mcp

MCP server that surfaces [replen](https://replen.dev) — your personalised daily OSS digest — inside Claude Code / Codex / any MCP host. The agent can ask:

- *"what new OSS surfaced for me this week?"*
- *"is github.com/owner/repo worth integrating into the codebase I have open?"*
- *"open handoff PRs for everything I starred"*

## What it exposes

| Tool | Returns |
|---|---|
| `digest_today` | Recent matches as JSON, filterable by days / relevance / project |
| `digest_search` | Full-text search across your digest history |
| `digest_starred` | Starred matches with handoff state |
| `digest_analyze_repo` | Raw README + repo meta + your project profiles — no LLM call on our side, lets the host agent judge fit against your open codebase |
| `digest_create_handoff` | Opens a handoff PR in the matched project's repo |
| `digest_feedback` | Records good / bad / star / unstar / hide |

The killer tool is `digest_analyze_repo` — by returning raw signals instead of running our pipeline, the agent reasons about fit with **your actual open codebase in context**, which the digest's nightly cron doesn't have.

## Install (one-liner)

Get your token from your replen `/settings` page → "Connect Claude Code", then run:

```bash
npx -y @replen/mcp setup --token=ing_xxxxxxxx --base=https://app.replen.dev
```

That writes the MCP entry into `~/.claude.json` (with a backup of the original) and is fully idempotent — re-run it any time you rotate the token.

**Restart Claude Code** to pick up the new server.

## What it actually does under the hood

- Adds `mcpServers.replen` to your Claude Code config
- `command: "replen-mcp"` — resolved via npx on each host launch, or `npm i -g @replen/mcp` for a slightly faster startup
- `env`: `DIGEST_BASE_URL` + `DIGEST_TOKEN`
- Existing MCP servers (firebase, neon, etc.) are preserved untouched
- A `.bak` of your config is saved next to it for one-step recovery

If you'd rather hand-edit your config, the block to add is:

```jsonc
{
  "mcpServers": {
    "replen": {
      "command": "replen-mcp",
      "env": {
        "DIGEST_BASE_URL": "https://app.replen.dev",
        "DIGEST_TOKEN": "ing_xxxxxxxx"
      }
    }
  }
}
```

## Other commands

```bash
replen-mcp --version     # print version
replen-mcp --help        # show available subcommands
replen-mcp               # run as stdio MCP server (your host spawns this; you usually don't run it directly)
```

## Example session

```
You: anything new today for my project X?
Agent: [calls digest_today({project: "my-project-x"})]
       2 matches today, top one is roboflow/supervision — 38k★ — MIT —
       relevance: high (85) · sourced via gh-trending.
       Want me to evaluate it against your current codebase?

You: yes
Agent: [calls digest_analyze_repo({owner: "roboflow", name: "supervision"})]
       [reads README + your project's tech summary]
       It's a drop-in replacement for your hand-rolled annotation utilities,
       plus deletes your ByteTrack reimplementation. Strong fit. Want a
       handoff PR?

You: yes
Agent: [calls digest_create_handoff({matchId: 96})]
       PR opened: github.com/you/my-project-x/pull/142
```

## Costs

- **Read-only tools** (`digest_today` / `digest_search` / `digest_starred`) cost nothing — pure JSON shuttle.
- **`digest_analyze_repo`** is one GitHub API call + the agent's own analysis cost (paid through your Claude subscription, not replen's).
- **`digest_create_handoff`** is one GitHub write call. No LLM on our side.

No additional replen-side cost vs the web dashboard — the MCP server queries the same API as `app.replen.dev`.

## License

MIT — see `LICENSE`.
