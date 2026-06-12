// `replen-mcp setup`: one-shot installer that writes the MCP server entry
// into the user's Claude Code config (~/.claude.json) without them having to
// hand-edit JSON. Idempotent: re-running with new flags just overwrites the
// replen block, leaves other MCP servers untouched.
//
// Usage:
//   replen-mcp setup --token=<DIGEST_TOKEN> [--base=<URL>] [--config=<path>] [--name=<key>]
//
// Driven by the "Connect Claude Code" button on /settings, which renders the
// exact one-liner with a fresh token already baked in. Users paste it into
// their terminal once; we never see the token transit.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

type Args = {
  token: string | null;
  base: string;
  configPath: string;
  name: string;
};

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : null;
  };
  return {
    token: get("token"),
    base: get("base") ?? "https://app.replen.dev",
    configPath: get("config") ?? join(homedir(), ".claude.json"),
    name: get("name") ?? "replen",
  };
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  // 0600 because the JSON contains DIGEST_TOKEN. Default 0644 leaks it
  // to every local user on a multi-user box.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort on non-POSIX */ }
}

export async function runSetup(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (!args.token) {
    console.error(`replen-mcp setup: install the MCP server entry into Claude Code config.

Usage:
  replen-mcp setup --token=<DIGEST_TOKEN> [--base=<URL>] [--config=<path>] [--name=<key>]

Required:
  --token=<token>     Personal token from your replen /settings → "Connect Claude Code"

Optional:
  --base=<url>        replen base URL (default: https://app.replen.dev)
  --config=<path>     Claude Code config path (default: ~/.claude.json)
  --name=<key>        Name to register under in mcpServers (default: replen)

After running this, restart Claude Code. The "${args.name}" MCP server will be available.
`);
    process.exit(1);
  }

  if (!args.token.startsWith("ing_")) {
    console.error(`Warning: token doesn't look like a Replen token (expected "ing_..." prefix). Continuing anyway.`);
  }
  try {
    new URL(args.base);
  } catch {
    console.error(`Error: --base=${args.base} is not a valid URL.`);
    process.exit(1);
  }

  console.error(`◆ replen MCP setup`);
  console.error(`  config:  ${args.configPath}`);
  console.error(`  server:  ${args.name}`);
  console.error(`  base:    ${args.base}`);

  // Back up first; never overwrite Claude config without a recovery path.
  // Timestamped so a re-run preserves the prior backup.
  if (existsSync(args.configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${args.configPath}.bak.${ts}`;
    writeFileSync(backup, readFileSync(args.configPath));
    console.error(`  backup:  ${backup}`);
  }

  const config = readJson(args.configPath);
  const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};

  const existing = mcpServers[args.name];
  if (existing) console.error(`  ↻ overwriting existing "${args.name}" entry`);

  mcpServers[args.name] = {
    type: "stdio",
    command: "replen-mcp",
    args: [],
    env: {
      DIGEST_BASE_URL: args.base,
      DIGEST_TOKEN: args.token,
    },
  };

  writeJsonAtomic(args.configPath, { ...config, mcpServers });

  installSlashCommand();

  console.error("\n✔ Installed.");
  console.error("→ Restart Claude Code to activate.");
  console.error(`→ Then try:  /replen   (lists available commands)`);
}

// Drops a `/replen` slash command into ~/.claude/commands/ so users get a
// discoverable menu of MCP tools. Best-effort: failures are warnings, never
// fatal — the MCP server still works without the slash command.
function installSlashCommand(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, "..", "extras", "replen.md");
    if (!existsSync(src)) {
      console.error(`  (slash command source missing at ${src}; skipping)`);
      return;
    }
    const commandsDir = join(homedir(), ".claude", "commands");
    mkdirSync(commandsDir, { recursive: true });
    const dest = join(commandsDir, "replen.md");
    const exists = existsSync(dest);
    copyFileSync(src, dest);
    console.error(`  ${exists ? "↻ updated" : "+ installed"} /replen command at ${dest}`);
  } catch (e) {
    console.error(`  (couldn't install /replen slash command: ${(e as Error).message})`);
  }
}
