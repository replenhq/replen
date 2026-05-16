import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Write the @replen/mcp server entry into Claude Code's config. Uses npx so
// the user doesn't need a separate global install; Claude Code will fetch
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
  // The file contains the user's ingest token (DIGEST_TOKEN). On a
  // multi-user box, the default 0644 leaks it to every local user, so
  // create the tmp file 0600 and chmod the final path after rename in
  // case the umask changed it on this platform.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that don't support chmod */ }
}

export async function setupMcp(token: string, base: string): Promise<void> {
  console.log(`  Wiring replen MCP into Claude Code config…`);

  if (existsSync(CONFIG_PATH)) {
    // Timestamp the backup so re-running setup never overwrites a previous
    // backup. Each run preserves the prior state.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${CONFIG_PATH}.bak.${ts}`;
    writeFileSync(backup, readFileSync(CONFIG_PATH));
    console.log(`  (backed up existing config to ${backup})`);
  }

  let config: Record<string, unknown>;
  try {
    config = readJson(CONFIG_PATH);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${CONFIG_PATH} is not valid JSON: ${msg}`);
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
