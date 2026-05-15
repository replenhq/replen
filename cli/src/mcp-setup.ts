import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Write the @replen/mcp server entry into Claude Code's config. Uses npx so
// the user doesn't need a separate global install — Claude Code will fetch
// @replen/mcp on first MCP launch and cache it.

const SERVER_NAME = "replen";
const CONFIG_PATH = join(homedir(), ".claude.json");

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export async function setupMcp(token: string, base: string): Promise<void> {
  console.log(`  Wiring replen MCP into Claude Code config…`);

  if (existsSync(CONFIG_PATH)) {
    const backup = `${CONFIG_PATH}.bak`;
    writeFileSync(backup, readFileSync(CONFIG_PATH));
    console.log(`  (backed up existing config to ${backup})`);
  }

  let config: Record<string, unknown>;
  try {
    config = readJson(CONFIG_PATH);
  } catch (e: any) {
    console.error(`  ✗ ${CONFIG_PATH} is not valid JSON: ${e.message}`);
    console.error(`    Fix the file manually and run \`replen mcp setup\`.`);
    process.exit(1);
  }

  const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const overwrite = !!mcpServers[SERVER_NAME];

  mcpServers[SERVER_NAME] = {
    type: "stdio",
    command: "npx",
    args: ["-y", "@replen/mcp"],
    env: {
      DIGEST_BASE_URL: base,
      DIGEST_TOKEN: token,
    },
  };

  writeJsonAtomic(CONFIG_PATH, { ...config, mcpServers });

  console.log(`  ✓ ${overwrite ? "Updated" : "Added"} "${SERVER_NAME}" in ${CONFIG_PATH}`);
}
