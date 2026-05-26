// Wires the @replen/mcp server entry into THREE MCP host configs in
// parallel, so the user gets zero-touch setup regardless of which
// agent they live in. Each host gets:
//
//   - Claude Code  → ~/.claude.json          (JSON, mcpServers object,
//                                              + SessionStart hook,
//                                              + /replen-match skill)
//   - Codex        → ~/.codex/config.toml    (TOML, [mcp_servers.replen]
//                                              table; AGENTS.md inject
//                                              provides session-start
//                                              surfacing)
//   - Gemini CLI   → ~/.gemini/settings.json (JSON, mcpServers object,
//                                              same shape as Claude;
//                                              GEMINI.md inject does
//                                              session-start surfacing)
//
// Each host's config is read, mutated only at the `replen` key, and
// written back atomically with a timestamped .bak. If a host's config
// path doesn't exist, we still create the directory + write the
// config — that way, when the user later installs Codex or Gemini, it
// just works without re-running setup.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { installSkills } from "./skill-install.js";

const SERVER_NAME = "replen";

const CLAUDE_CONFIG = join(homedir(), ".claude.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const GEMINI_CONFIG = join(homedir(), ".gemini", "settings.json");

// ============================================================================
// Public entry point
// ============================================================================

export async function setupMcp(token: string, base: string): Promise<void> {
  console.log(`  Wiring replen MCP into agent configs…`);

  const results: HostSetupResult[] = [];
  results.push(setupClaude(token, base));
  results.push(setupCodex(token, base));
  results.push(setupGemini(token, base));

  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.label}: ${r.action} (${r.path})`);
    } else {
      console.warn(`  ⚠ ${r.label}: skipped — ${r.error}`);
    }
  }

  // Skill install is Claude-Code-specific (skills live under
  // ~/.claude/skills/). Other MCP hosts read the MCP tool descriptions
  // directly; the replen_match tool description embeds the triage
  // playbook so Codex / Gemini agents follow the same protocol without
  // a separate skill file.
  installSkills();

  // CLAUDE.md / AGENTS.md / GEMINI.md inject is the proactive-surfacing
  // mechanism for each host. Without it, the agent doesn't know to
  // call replen_check_new at session start. Idempotent + versioned.
  console.log("");
  const { injectInstructions, summariseOutcome } = await import("./inject-instruction.js");
  const outcome = await injectInstructions();
  const summary = summariseOutcome(outcome);
  if (summary) console.log(summary);
}

// ============================================================================
// Per-host setup
// ============================================================================

type HostSetupResult =
  | { ok: true; label: string; path: string; action: "added" | "updated" }
  | { ok: false; label: string; path: string; error: string };

function setupClaude(token: string, base: string): HostSetupResult {
  const path = CLAUDE_CONFIG;
  try {
    backupIfExists(path);
    const config = readJson(path);
    const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
    const existed = !!mcpServers[SERVER_NAME];

    mcpServers[SERVER_NAME] = {
      type: "stdio",
      command: "npx",
      args: ["-y", "@replen/mcp"],
      env: { DIGEST_BASE_URL: base, DIGEST_TOKEN: token },
    };

    const hooks = installSessionStartHook(
      (config.hooks as Record<string, unknown> | undefined) ?? {},
    );

    writeJsonAtomic(path, { ...config, mcpServers, hooks });
    return { ok: true, label: "Claude Code", path, action: existed ? "updated" : "added" };
  } catch (e) {
    return { ok: false, label: "Claude Code", path, error: (e as Error).message };
  }
}

function setupGemini(token: string, base: string): HostSetupResult {
  const path = GEMINI_CONFIG;
  try {
    backupIfExists(path);
    const config = readJson(path);
    const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
    const existed = !!mcpServers[SERVER_NAME];

    // Gemini CLI's MCP config shape matches Claude's (per
    // docs/tools/mcp-server.md): command, args, env. No `type` field.
    mcpServers[SERVER_NAME] = {
      command: "npx",
      args: ["-y", "@replen/mcp"],
      env: { DIGEST_BASE_URL: base, DIGEST_TOKEN: token },
    };

    writeJsonAtomic(path, { ...config, mcpServers });
    return { ok: true, label: "Gemini CLI", path, action: existed ? "updated" : "added" };
  } catch (e) {
    return { ok: false, label: "Gemini CLI", path, error: (e as Error).message };
  }
}

function setupCodex(token: string, base: string): HostSetupResult {
  const path = CODEX_CONFIG;
  try {
    backupIfExists(path);
    const config = readToml(path);
    const mcpServers = (config.mcp_servers as Record<string, unknown> | undefined) ?? {};
    const existed = !!mcpServers[SERVER_NAME];

    // Codex TOML shape per codex-rs source: command, args, env table.
    // `env` is a TOML inline table when serialised, which smol-toml
    // handles automatically for small objects.
    mcpServers[SERVER_NAME] = {
      command: "npx",
      args: ["-y", "@replen/mcp"],
      env: { DIGEST_BASE_URL: base, DIGEST_TOKEN: token },
    };

    writeTomlAtomic(path, { ...config, mcp_servers: mcpServers });
    return { ok: true, label: "Codex", path, action: existed ? "updated" : "added" };
  } catch (e) {
    return { ok: false, label: "Codex", path, error: (e as Error).message };
  }
}

// ============================================================================
// File helpers (atomic write, backup, JSON/TOML parsers)
// ============================================================================

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return parseToml(raw) as Record<string, unknown>;
}

function writeJsonAtomic(path: string, data: unknown): void {
  writeAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

function writeTomlAtomic(path: string, data: Record<string, unknown>): void {
  writeAtomic(path, stringifyToml(data) + "\n");
}

// Shared atomic-write path. Both JSON and TOML files contain the
// DIGEST_TOKEN secret, so we create the tmp file 0600 and chmod the
// final path to 0600 too in case the umask changed it.
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms that don't support chmod */
  }
}

function backupIfExists(path: string): void {
  if (!existsSync(path)) return;
  // Timestamp the backup so re-running setup never overwrites a
  // previous backup. Each run preserves the prior state.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak.${ts}`;
  writeFileSync(backup, readFileSync(path));
}

// ============================================================================
// Claude SessionStart hook
// ============================================================================

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
//
// Codex and Gemini have no equivalent SessionStart hook concept (as of
// their current docs). Both rely on the AGENTS.md / GEMINI.md project-
// context file being read at session start, which our inject step
// covers.
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
