import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { installSkills } from "./skill-install.js";

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

  const hooks = installSessionStartHook(
    (config.hooks as Record<string, unknown> | undefined) ?? {},
  );

  writeJsonAtomic(CONFIG_PATH, { ...config, mcpServers, hooks });

  console.log(`  ✓ ${overwrite ? "Updated" : "Added"} "${SERVER_NAME}" in ${CONFIG_PATH}`);
  console.log(`  ✓ Installed SessionStart hook (surfaces new matches automatically)`);

  // Skill install runs alongside the MCP+hook setup so any Claude Code
  // session can `/replen-match` to trigger in-session triage. Other MCP
  // hosts (Codex, Cursor) don't have a skills concept; they use the
  // replen_match MCP tool description as the equivalent instruction.
  installSkills();

  // Auto-inject the "## Replen integration" section into each local
  // project's CLAUDE.md. This is the adoption-unblock — without it
  // Claude Code (v2.1.141) doesn't reliably auto-surface matches
  // because the SessionStart hook stdout-injection is buggy. Per-project
  // CLAUDE.md instruction is the only working surface today, and we
  // can't expect every user to hand-edit every repo. Idempotent +
  // versioned; safe to re-run.
  console.log("");
  const { injectInstructions, summariseOutcome } = await import("./inject-instruction.js");
  const outcome = await injectInstructions();
  const summary = summariseOutcome(outcome);
  if (summary) console.log(summary);
}

// SessionStart hook: on every Claude Code session, runs `replen check-new
// --hook`, which prints a one-block summary to stdout if (and only if)
// new actionable matches landed since the user last engaged. Claude Code
// injects that stdout into the agent's opening context, so the agent
// surfaces the matches to the user without anyone having to ask.
//
// When nothing's new the command prints nothing — silence is the calm-
// cadence position. The 2-second timeout (handled inside check-new --hook)
// ensures a slow API can't stall session opening.
//
// We use the command string `npx --quiet replen check-new --hook` as our
// idempotency marker: if a SessionStart entry already contains that
// substring we replace it; otherwise we append. Any other SessionStart
// hooks the user has are preserved verbatim.
const HOOK_COMMAND = "npx --quiet replen check-new --hook";
const HOOK_MARKER = "replen check-new --hook";

type HookEntry = {
  matcher?: string;
  hooks?: Array<{ type: string; command?: string }>;
};

function installSessionStartHook(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const sessionStart = ((existing.SessionStart as HookEntry[] | undefined) ?? []).slice();

  const ours: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  };

  const idx = sessionStart.findIndex((entry) =>
    (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(HOOK_MARKER)),
  );

  if (idx >= 0) {
    sessionStart[idx] = ours;
  } else {
    sessionStart.push(ours);
  }

  return { ...existing, SessionStart: sessionStart };
}
