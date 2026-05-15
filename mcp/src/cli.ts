#!/usr/bin/env node
// Entry point. Two modes:
//   - `replen-mcp setup --token=... [--base=...]`  → installer (writes Claude config)
//   - `replen-mcp` (no args)                       → stdio MCP server

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./server.js";
import { runSetup } from "./setup.js";

async function main() {
  if (process.argv[2] === "setup") {
    await runSetup(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "--version" || process.argv[2] === "-v") {
    // Read version from package.json at runtime — keeps single source of truth.
    const pkg = JSON.parse(
      (await import("fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    console.log(pkg.version);
    return;
  }
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.error(`replen-mcp — MCP server for replen (https://replen.dev)

Commands:
  replen-mcp setup --token=<DIGEST_TOKEN> [--base=<URL>]
      Install this server's entry into ~/.claude.json. Restart Claude Code after.

  replen-mcp
      Run as MCP stdio server. Reads DIGEST_TOKEN and DIGEST_BASE_URL from env.
      Spawned by your MCP host (Claude Code / Codex) — you shouldn't run this directly.
`);
    return;
  }
  const baseUrl = (process.env.DIGEST_BASE_URL ?? "http://localhost:3030").replace(/\/+$/, "");
  const token = process.env.DIGEST_TOKEN;
  if (!token) {
    console.error("DIGEST_TOKEN env var required. Generate one on /settings of your digest dashboard.");
    process.exit(1);
  }

  const server = new Server(
    { name: "replen", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(server, { baseUrl, token });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr because stdout is the MCP transport channel.
  console.error(`[replen-mcp] connected · base=${baseUrl}`);
}

main().catch((e) => {
  console.error("[replen-mcp] fatal:", e);
  process.exit(1);
});
