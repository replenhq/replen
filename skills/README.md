# Replen skills

Claude Code skills that wrap the [replen MCP server](../mcp/) into morning-triage style workflows.

The MCP gives the agent **tools** (data access). The skills give the agent **procedures** (when to call what, in what order, and what to do with the results). They're complementary - install both.

## Available skills

| Skill | Invocation | What it does |
|---|---|---|
| `replen` | `/replen` or "what's new from Replen?" | Pull today's candidate inventory (`replen_match`), triage each candidate in-session against your code, record the verdicts (`replen_record_triage` / `replen_capture_insight`), and surface only the wins inline in the chat. No HTML report. |
| `replen-onboard` | `/replen-onboard` or "set up Replen" | One-time grounding setup: works through your active repos, reads each one's code, tidies thin/missing docs, and builds a tailored profile (capabilities + report) so Replen surfaces useful tools instead of generic ones. |

## Install

```bash
mkdir -p ~/.claude/skills
cp -r skills/replen ~/.claude/skills/
```

Restart Claude Code. Skills are auto-discovered from `~/.claude/skills/`.

## Requires

- The [replen MCP server](../mcp/) configured in your Claude Code MCP config.
- A `DIGEST_TOKEN` generated from `/settings` on your replen dashboard.

## Why a skill on top of an MCP?

Short answer: the MCP gives the agent *tools*; the skill gives it a *playbook*.

Long answer: read [cra.mr - MCP, Skills, and Agents](https://cra.mr/mcp-skills-and-agents/) and [LlamaIndex - Skills vs MCP Tools](https://www.llamaindex.ai/blog/skills-vs-mcp-tools-for-agents-when-to-use-what). The TL;DR is that domain volatility decides - your matches DB changes daily (MCP wins for that), but the *triage protocol* is stable (skill wins for that).
