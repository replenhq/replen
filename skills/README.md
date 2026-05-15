# Replen skills

Claude Code skills that wrap the [replen MCP server](../mcp/) into morning-triage style workflows.

The MCP gives the agent **tools** (data access). The skills give the agent **procedures** (when to call what, in what order, and what to do with the results). They're complementary - install both.

## Available skills

| Skill | Invocation | What it does |
|---|---|---|
| `replen-triage` | `/replen-triage` or "triage my digest" | Fetch today's matches, evaluate the high-relevance ones, generate a styled **HTML triage report** (`~/replen/reports/triage-DATE.html`) you can scan + share. Optional briefing sub-protocol produces per-repo HTML deep-dives (`~/replen/briefings/owner-name-DATE.html`). |

### Why HTML output?

The skill writes HTML artifacts instead of dumping markdown into the chat, following [Thariq's "Unreasonable Effectiveness of HTML"](https://x.com/trq212/status/2053872850101285137) argument: triage reports are read-only, scan-heavy, never edited - exactly the kind of artifact where HTML's information density (colour-coded chips, SVG diagrams, click-through links, copy-to-clipboard action buttons) beats markdown. The chat output stays terse; the HTML is the deliverable.

The skill ships with two reference HTML files (`reference-triage.html`, `reference-briefing.html`) that anchor the visual style - Claude generates fresh HTML each run matching those references rather than mechanically filling a rigid template.

## Install

```bash
mkdir -p ~/.claude/skills
cp -r skills/replen-triage ~/.claude/skills/
```

Restart Claude Code. Skills are auto-discovered from `~/.claude/skills/`.

## Requires

- The [replen MCP server](../mcp/) configured in your Claude Code MCP config.
- A `DIGEST_TOKEN` generated from `/settings` on your replen dashboard.

## Why a skill on top of an MCP?

Short answer: the MCP gives the agent *tools*; the skill gives it a *playbook*.

Long answer: read [cra.mr - MCP, Skills, and Agents](https://cra.mr/mcp-skills-and-agents/) and [LlamaIndex - Skills vs MCP Tools](https://www.llamaindex.ai/blog/skills-vs-mcp-tools-for-agents-when-to-use-what). The TL;DR is that domain volatility decides - your matches DB changes daily (MCP wins for that), but the *triage protocol* is stable (skill wins for that).
