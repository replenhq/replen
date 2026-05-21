#!/usr/bin/env node
import { runInit } from "./init.js";
import { setupMcp } from "./mcp-setup.js";
import { readConfig, configPath } from "./config.js";
import { runProjectInit } from "./project-init.js";
import { runFeed, runHandoff, runProgress, runRun, runSearch, runStarred } from "./commands.js";

const HELP = `replen: Smarter AI Development workflows

Usage:
  npx replen                 Sign up / sign in + wire MCP into Claude Code
  npx replen status          Show CLI auth + config
  npx replen mcp setup       Re-wire MCP using saved auth
  npx replen project-init    Print a prompt your AI coding tool uses to draft
                             a CLAUDE.md tuned for replen
  npx replen logout          Forget saved auth
  npx replen --help          This help

Use replen from a plain shell (no Claude Code / Codex needed):
  npx replen run                       Trigger a fresh pipeline run
  npx replen progress                  Live tail of the current run; exits when done
  npx replen feed [--days N]           Today's matches (default 2 days)
                  [--project SLUG]     Limit to one project
                  [--relevance high,medium]
  npx replen search <query>            Full-text search across past matches
  npx replen starred                   Starred matches + handoff PR status
  npx replen handoff <matchId>         Open the handoff PR for a starred match

Every data command accepts --json to dump raw JSON for scripting / jq.

Env:
  REPLEN_BASE             Override dashboard URL (default https://app.replen.dev)

Learn more: https://replen.dev
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }

  if (cmd === "status") {
    const cfg = await readConfig();
    if (!cfg) {
      console.log(`Not signed in. Run \`npx replen\` to set up.`);
      process.exit(1);
    }
    console.log(`Signed in.`);
    console.log(`  Dashboard: ${cfg.base}`);
    console.log(`  Saved:     ${cfg.savedAt}`);
    console.log(`  Config:    ${configPath()}`);
    return;
  }

  if (cmd === "project-init") {
    runProjectInit();
    return;
  }

  if (cmd === "mcp" && argv[1] === "setup") {
    const cfg = await readConfig();
    if (!cfg) {
      console.error(`Not signed in. Run \`npx replen\` first.`);
      process.exit(1);
    }
    await setupMcp(cfg.token, cfg.base);
    console.log(`\nRestart Claude Code to pick up the change.`);
    return;
  }

  if (cmd === "logout") {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(configPath());
      console.log(`Forgot auth at ${configPath()}`);
    } catch (e) {
      if ((e as { code?: string })?.code === "ENOENT") {
        console.log(`No saved auth; nothing to forget.`);
      } else {
        throw e;
      }
    }
    console.log(`Note: this only clears local auth. The token is still valid until you rotate it on /settings.`);
    return;
  }

  if (cmd === "run") return runRun(argv);
  if (cmd === "progress") return runProgress(argv);
  if (cmd === "feed") return runFeed(argv);
  if (cmd === "search") return runSearch(argv);
  if (cmd === "starred") return runStarred(argv);
  if (cmd === "handoff") return runHandoff(argv);

  if (cmd === undefined) {
    // Default: if already signed in, just rerun mcp setup. Otherwise, full flow.
    const cfg = await readConfig();
    if (cfg) {
      console.log(`Already signed in to ${cfg.base}. Re-wiring MCP config…`);
      await setupMcp(cfg.token, cfg.base);
      console.log(`\nDone. Run \`npx replen status\` to inspect.`);
      return;
    }
    await runInit();
    return;
  }

  console.error(`Unknown command: ${cmd}\n`);
  console.error(HELP);
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n✗ ${e?.message ?? String(e)}`);
  process.exit(1);
});
