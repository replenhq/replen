#!/usr/bin/env node
import { runInit } from "./init.js";
import { setupMcp } from "./mcp-setup.js";
import { readConfig, configPath } from "./config.js";
import { runProjectInit } from "./project-init.js";
import { runCheckNew, runFeed, runHandoff, runProgress, runRun, runSearch, runStarred, runWatch, runAtlas } from "./commands.js";

const HELP = `replen: Smarter AI Development workflows

Usage:
  npx replen                 Sign up / sign in + wire MCP into Claude Code
  npx replen status          Show CLI auth + config
  npx replen mcp setup       Re-wire MCP using saved auth
  npx replen project-init    Print a prompt your AI coding tool uses to draft
                             a CLAUDE.md tuned for replen
  npx replen inject [-y]     Append the "## Replen integration" section to
                             every CLAUDE.md + AGENTS.md (Claude Code +
                             Codex) under ~/github/, ~/code/, ~/projects/
                             so the agent auto-surfaces matches on session
                             start. Idempotent. Asks for consent unless -y.
  npx replen sync-projects   Re-scan local repos for new GitHub remotes
       [--root PATH ...]     and register them with Replen. Run after
                             cloning a new repo, or pass --root to point
                             at a non-conventional layout.
  npx replen vault <spec>... Point Replen at a knowledge-graph vault
                             (Obsidian / Graphify / ADRs) that lives OUTSIDE
                             a repo, so onboarding grounds from it. Repeatable.
                             A bare path is a global vault (covers all repos);
                             owner/name=path scopes one to a repo. e.g.
                               npx replen vault ~/ObsidianVault
                               npx replen vault me/drone=~/graphs/drone
                             \`npx replen vault --list\` shows configured vaults.
                             (--vault PATH also works on \`npx replen\` + sync.)
  npx replen immerse [on|off] Ground matching on your ACTUAL code, not just
       [status]              its description (hosted opt-in; self-host has it
                             on by default). \`on\` opts in and sends; bare
                             sends for an opted-in account. Vectors-only: your
                             code is embedded server-side, then discarded.
  npx replen atlas           Write your knowledge graph as an owned,
                             Obsidian-compatible markdown vault to
                             ~/.replen/atlas/ (projects, capabilities,
                             decisions, themes, all cross-linked)
  npx replen logout          Forget saved auth
  npx replen uninstall       Remove Replen's local footprint (MCP wiring,
       [--dry-run] [-y]      skills, per-repo doc blocks, ~/.replen). Asks
       [--root PATH ...]     before each category; nothing goes without a yes.
                             Server-side profile is untouched (delete that at
                             app.replen.dev). --dry-run previews, -y skips
                             prompts.
  npx replen --help          This help

Use replen from a plain shell (no Claude Code / Codex needed):
  npx replen run                       Trigger a fresh pipeline run
  npx replen progress                  Live tail of the current run; exits when done
  npx replen check-new                 One-shot: any new actionable matches
                  [--repo OWNER/NAME]  since you last engaged? Used by the
                                       SessionStart hook to surface new
                                       matches automatically in Claude Code.
  npx replen feed [--days N]           Today's matches (default 2 days)
                  [--project SLUG]     Limit to one project
                  [--relevance high,medium]
  npx replen watch                     Long-running poll: rings the terminal bell
                  [--interval SEC]     when a new match lands (default 300s).
                  [--days N]           First poll establishes baseline; existing
                  [--project SLUG]     matches don't ring. Ctrl-C to stop.
                  [--relevance high,medium]
                  [--no-bell]
  npx replen search <query>            Full-text search across past matches
  npx replen starred                   Starred matches + handoff PR status
  npx replen handoff <matchId>         Open the handoff PR for a starred match

Every data command accepts --json to dump raw JSON for scripting / jq.

Env:
  REPLEN_BASE             Override dashboard URL (default https://app.replen.dev)
  REPLEN_PROJECT_ROOTS    Colon-separated list of dirs to scan for git repos.
                          Overrides auto-detection. e.g. ~/work:~/src

Project discovery (when run without --root and REPLEN_PROJECT_ROOTS unset):
  1. Walks up from the current dir to find a git repo, suggests its parent
  2. Reads ~/.claude.json for tracked Claude Code project paths
  3. Falls back to ~/github, ~/code, ~/projects, ~/dev, ~/src, ~/work
  4. Prompts you interactively if none of the above turn up anything

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

  if (cmd === "uninstall") {
    const { runUninstall } = await import("./uninstall.js");
    await runUninstall(argv.slice(1));
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

  if (cmd === "inject") {
    const { injectInstructions, summariseOutcome } = await import("./inject-instruction.js");
    const yes = argv.includes("--yes") || argv.includes("-y");
    const explicitRoots = collectRootFlags(argv);
    const outcome = await injectInstructions({ yes, explicitRoots });
    const summary = summariseOutcome(outcome);
    if (summary) console.log(summary);
    return;
  }

  if (cmd === "vault") {
    const cfg = await readConfig();
    if (!cfg) {
      console.error("Not signed in. Run `npx replen` first.");
      process.exit(1);
    }
    const { collectVaultFlags, persistVaults, summariseVaults, hasVaultFlags } = await import("./vaults.js");
    if (argv.includes("--list")) {
      const v = cfg.vaults;
      const empty = !v || ((v.global?.length ?? 0) === 0 && Object.keys(v.byRepo ?? {}).length === 0);
      console.log(
        empty
          ? "No vaults configured.\n  Add one:  npx replen vault ~/ObsidianVault\n            npx replen vault owner/name=~/graphs/thing"
          : "Configured knowledge-graph vaults:\n" + summariseVaults(v!),
      );
      return;
    }
    const specs = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (specs.length === 0) {
      console.error("Usage: npx replen vault <path | owner/name=path> ...   (or --list)");
      process.exit(1);
    }
    const parsed = collectVaultFlags(specs.flatMap((s) => ["--vault", s]));
    if (!hasVaultFlags(parsed)) {
      console.error("No valid vault paths given (each must be an existing directory).");
      process.exit(1);
    }
    const vaults = await persistVaults(parsed);
    if (vaults) {
      console.log(summariseVaults(vaults));
      console.log("\n  Re-run /replen-onboard in Claude Code so the agent re-grounds from the vault.");
    }
    return;
  }

  if (cmd === "sync-projects" || cmd === "sync") {
    const cfg = await readConfig();
    if (!cfg) {
      console.error("Not signed in. Run `npx replen` first.");
      process.exit(1);
    }
    const explicitRoots = collectRootFlags(argv);
    const { collectVaultFlags, persistVaults, summariseVaults } = await import("./vaults.js");
    const savedVaults = await persistVaults(collectVaultFlags(argv));
    if (savedVaults) console.log(summariseVaults(savedVaults));
    const { syncDiscoveredProjects } = await import("./sync-projects.js");
    await syncDiscoveredProjects({ token: cfg.token, base: cfg.base, explicitRoots });
    return;
  }

  if (cmd === "immerse") {
    const { runImmerse } = await import("./immerse.js");
    return runImmerse(argv.slice(1));
  }

  if (cmd === "run") return runRun(argv);
  if (cmd === "progress") return runProgress(argv);
  if (cmd === "feed") return runFeed(argv);
  if (cmd === "watch") return runWatch(argv);
  if (cmd === "check-new") return runCheckNew(argv);
  if (cmd === "search") return runSearch(argv);
  if (cmd === "starred") return runStarred(argv);
  if (cmd === "handoff") return runHandoff(argv);
  if (cmd === "atlas") return runAtlas(argv);

  if (cmd === undefined) {
    // Default: if already signed in, just rerun mcp setup. Otherwise, full flow.
    const cfg = await readConfig();
    const { collectVaultFlags, persistVaults, summariseVaults } = await import("./vaults.js");
    const parsedVaults = collectVaultFlags(argv);
    if (cfg) {
      console.log(`Already signed in to ${cfg.base}. Re-wiring MCP config…`);
      await setupMcp(cfg.token, cfg.base);
      const v = await persistVaults(parsedVaults);
      if (v) console.log(summariseVaults(v));
      console.log(`\nDone. Run \`npx replen status\` to inspect.`);
      return;
    }
    await runInit();
    // Config now exists — persist any --vault passed to first-run setup so the
    // onboarding agent (run next in Claude Code) grounds from it.
    const v = await persistVaults(parsedVaults);
    if (v) console.log(summariseVaults(v));
    return;
  }

  console.error(`Unknown command: ${cmd}\n`);
  console.error(HELP);
  process.exit(1);
}

/**
 * Parse one or more `--root <path>` (or `--root=<path>`) flags out of
 * the argv tail. Doesn't validate the path — discover-roots.ts handles
 * existence + stat checks downstream.
 */
function collectRootFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      out.push(argv[++i]);
    } else if (arg.startsWith("--root=")) {
      out.push(arg.slice("--root=".length));
    }
  }
  return out;
}

main().catch((e) => {
  console.error(`\n✗ ${e?.message ?? String(e)}`);
  process.exit(1);
});
