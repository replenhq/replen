#!/usr/bin/env node
// Entry point. Two modes:
//   - `replen-mcp setup --token=... [--base=...]`  → installer (writes Claude config)
//   - `replen-mcp` (no args)                       → stdio MCP server

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./server.js";
import { runSetup } from "./setup.js";
import { detectCurrentRepo } from "./repo-detect.js";
import { refreshAtlasVaultInBackground } from "./atlas-sync.js";
import { autoRegisterCwdRepoInBackground } from "./auto-register.js";

async function main() {
  if (process.argv[2] === "setup") {
    await runSetup(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "--version" || process.argv[2] === "-v") {
    // Read version from package.json at runtime; keeps single source of truth.
    const pkg = JSON.parse(
      (await import("fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    console.log(pkg.version);
    return;
  }
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.error(`replen-mcp: MCP server for replen (https://replen.dev)

Commands:
  replen-mcp setup --token=<DIGEST_TOKEN> [--base=<URL>]
      Install this server's entry into ~/.claude.json. Restart Claude Code after.

  replen-mcp
      Run as MCP stdio server. Reads DIGEST_TOKEN and DIGEST_BASE_URL from env.
      Spawned by your MCP host (Claude Code / Codex); you shouldn't run this directly.
`);
    return;
  }
  const baseUrl = (process.env.DIGEST_BASE_URL ?? "http://localhost:3030").replace(/\/+$/, "");
  const token = process.env.DIGEST_TOKEN;
  if (!token) {
    // An MCP host (Claude Code / Codex) spawns this over stdio pipes and
    // injects DIGEST_TOKEN. A human running `npx -y @replen/mcp@latest` by
    // hand (almost always to refresh the npx cache before a new session) has
    // an interactive terminal — a TTY — and no token. Detecting the TTY lets
    // us show that person a SUCCESS message (the package just downloaded fine;
    // nothing is wrong) instead of an error-shaped "token required" line.
    const pkg = JSON.parse(
      (await import("fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const interactive = process.stdout.isTTY || process.stderr.isTTY;
    if (interactive) {
      console.log(
        `✓ @replen/mcp ${pkg.version} is installed and cached.\n\n` +
        `Nothing to do here — this server runs *inside* Claude Code / Codex, which\n` +
        `connects to it automatically. You ran it directly (e.g. to pull the latest\n` +
        `version), and that worked.\n\n` +
        `Next: restart your AI session to pick up this version.\n` +
        `First-time setup instead? Run \`npx replen\`.`,
      );
      process.exit(0);
    }
    // Spawned by a host but no token injected — that IS a misconfiguration.
    console.error("DIGEST_TOKEN not provided by the MCP host. Re-run `npx replen` to (re)write the server config, then restart your session. Token setup: app.replen.dev/settings.");
    process.exit(1);
  }

  const server = new Server(
    { name: "replen", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Repo-scoping: detect the GitHub repo we were spawned in so tool calls
  // (replen_match, etc.) default to that scope.
  // Best-effort — silent fallback to user-scoped behaviour when no git origin
  // is reachable. An explicit `repo: ""` on any call overrides this default
  // and asks for everything across all the user's projects.
  const detected = detectCurrentRepo();
  const defaultRepo = detected?.ownerRepo ?? null;
  const repoToplevel = detected?.toplevel ?? null;
  const cfg = { baseUrl, token, defaultRepo, repoToplevel };

  registerTools(server, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr because stdout is the MCP transport channel.
  console.error(
    `[replen-mcp] connected · base=${baseUrl}` +
    (defaultRepo ? ` · scope=${defaultRepo}` : ` · scope=(no git repo detected)`),
  );

  // Keep the local Atlas tiles (~/.replen/atlas/) fresh in the background —
  // fire-and-forget, debounced (twice a day max), never blocks the transport.
  refreshAtlasVaultInBackground(cfg);

  // Self-register the spawn repo's identity if Replen hasn't seen it yet. The
  // CC SessionStart hook already does this on Claude Code; doing it here makes
  // it host-agnostic (Codex / Cursor / Gemini), so a brand-new repo no longer
  // needs a manual `npx replen sync-projects`. Silent, bounded, cache-gated.
  autoRegisterCwdRepoInBackground(cfg);
}

main().catch((e) => {
  console.error("[replen-mcp] fatal:", e);
  process.exit(1);
});
