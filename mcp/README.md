# @replen/mcp

**Smarter AI Development workflows.** MCP server that brings [replen](https://replen.dev) - the AI that asks *"can we do this better?"* on your codebase - inside Claude Code / Codex / any MCP host.

While your AI coding tool waits for prompts, replen reads your code against the ecosystem every morning. This MCP lets the agent act on the results without leaving chat:

- *"what new tools shipped this week that fit my project?"*
- *"is github.com/owner/repo worth integrating into the codebase I have open?"*
- *"open handoff PRs for everything I starred"*

## What it exposes

replen ships **15 tools**. Three moving parts sit behind them: **Brainstem** matches, **Watchtower** watches, **Atlas** remembers. The tools group under Brainstem, Atlas, and onboarding.

### Brainstem (the matching loop, in-session on your own subscription tokens)

| Tool | Returns |
|---|---|
| `replen_match` | The cwd repo's candidate inventory: repo metadata + cosine scores + `whyShortlisted` lines, everything Watchtower surfaced and Brainstem scored against this codebase's capabilities |
| `replen_record_triage` | Records the agent's per-candidate verdict (adopt / port / cherry-pick / clean-room / upgrade / skip / defer) with score, effort, and reasoning |
| `replen_state` | Records the user's action on a candidate: star / hide / handoff / surfaced |
| `replen_capture_insight` | Stores a portfolio insight from triage: a transferable lesson or a sharpened boundary |

### Atlas (the knowledge graph + memory)

| Tool | Returns |
|---|---|
| `replen_leaps` | Non-obvious cross-project / adjacency / cross-user connections from Atlas, each with a `via` path |
| `replen_recall` | Memory across your whole portfolio: past verdicts, grounded reports, capabilities, and notes for a query |
| `replen_cart` | Pulls a saved or built-in **Atlas Cart's** rows in-session (Blind spots, Triage board, Keystones, Brought in, Stale deferrals, By domain, or your saved carts) |
| `replen_queue` | The awareness-to-action queue: list / add / done / dismiss items carried over from the Brief |
| `replen_handoff` | Opens a handoff PR in the matched project's repo |

### Onboarding (grounding a project)

| Tool | Returns |
|---|---|
| `replen_onboard_state` | Per-repo grounding state across the portfolio, the cheap pre-flight for `/replen-onboard` |
| `replen_set_capabilities` | Writes a project's grounded capabilities + report (read locally by the agent, never uploaded as raw files) |
| `replen_set_tags` | Writes a project's ranked domain tag cloud |
| `replen_set_versions` | Writes a project's pinned direct-dependency + runtime versions |
| `replen_set_product` | Groups sibling repos under one product |

Plus `replen_help`, the tool index.

The core tool is `replen_match`: it returns the cwd repo's candidate inventory (metadata + cosine + `whyShortlisted`) with **no LLM call on our side**, so the host agent reasons about fit against **your actual open codebase in context**, then records each call via `replen_record_triage`. **Atlas** now has two halves: the graph/explore view and **Carts**, browsable filterable views over your decision graph that `replen_cart` reads in-session.

## Install (one-liner)

Get your token from your replen `/settings` page → "Connect Claude Code", then run:

```bash
npx -y @replen/mcp setup --token=ing_xxxxxxxx --base=https://app.replen.dev
```

That writes the MCP entry into `~/.claude.json` (with a backup of the original) and is fully idempotent - re-run it any time you rotate the token.

**Restart Claude Code** to pick up the new server.

## What it actually does under the hood

- Adds `mcpServers.replen` to your Claude Code config
- `command: "replen-mcp"` - resolved via npx on each host launch, or `npm i -g @replen/mcp` for a slightly faster startup
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
Agent: [calls replen_match({repo: "you/my-project-x"})]
       2 candidates for this repo, top one is roboflow/supervision - 38k★ - MIT -
       cosine 0.71 · whyShortlisted: fills your "object tracking" capability.
       Want me to triage them against your current codebase?

You: yes
Agent: [reads the candidate README + greps your src/ for related code]
       supervision drops in for your hand-rolled annotation utilities and
       deletes your ByteTrack reimplementation. Strong fit.
       [calls replen_record_triage({repo: "roboflow/supervision", verdict: "adopt", ...})]
       Recorded. Want a handoff PR?

You: yes
Agent: [calls replen_state({repo: "roboflow/supervision", status: "handed_off", ...})]
       [calls replen_handoff({matchId: 96})]
       PR opened: github.com/you/my-project-x/pull/142
```

## Costs

- **Read-only tools** (`replen_match` / `replen_cart` / `replen_recall` / `replen_leaps`) cost nothing - pure JSON shuttle.
- **Triage** (the per-candidate verdict + writeup) is the agent's own reasoning, paid through your Claude subscription inside the session, never on our side. Replen stores no LLM API key and makes no per-candidate model call; the only server-side model work is cheap embeddings + a catalogue classifier on Replen's own account.
- **`replen_handoff`** is one GitHub write call. No LLM on our side.

No additional replen-side cost vs the web dashboard - the MCP server queries the same API as `app.replen.dev`.

## License

Apache-2.0 - see `LICENSE`. Permissive open source: free to use, modify, and redistribute for any purpose, with an explicit patent grant. "Replen" and the other named surfaces remain trademarks (Apache §6).
