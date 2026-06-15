// Wires the @replen/mcp server entry into THREE MCP host configs in
// parallel, so the user gets zero-touch setup regardless of which
// agent they live in. Each host gets:
//
//   - Claude Code  → ~/.claude.json          (JSON, mcpServers object,
//                                              + SessionStart hook,
//                                              + /replen skill)
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
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { installSkills } from "./skill-install.js";

const SERVER_NAME = "replen";

// Launch the MCP via an EXACT pinned version, resolved from the npm registry at
// setup time — mirrors how the SessionStart hook pins replen@<version>. We used
// `@^1` for "auto-update each session", but npx caches per-spec and happily
// reuses a stale `@^1` resolution even after `npx @latest` — so the auto-update
// was illusory AND users got spurious "newer Replen available" nudges right after
// updating (the server sees the still-stale client version). Pinning the exact
// version makes each release a distinct, correctly-cached npx entry; re-running
// `npx replen mcp setup` re-resolves + re-pins to ship an update. Falls back to
// the `@^1` range only if the registry is unreachable at setup time.
let MCP_PKG = "@replen/mcp@^1";

// Resolve the exact latest @replen/mcp version to pin (fail-open to the range).
async function resolveMcpPkg(): Promise<string> {
  try {
    const res = await fetch("https://registry.npmjs.org/@replen/mcp/latest", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const j = (await res.json()) as { version?: string };
      if (typeof j.version === "string" && j.version) return `@replen/mcp@${j.version}`;
    }
  } catch { /* registry unreachable — keep the range fallback */ }
  return "@replen/mcp@^1";
}

const CLAUDE_CONFIG = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const GEMINI_CONFIG = join(homedir(), ".gemini", "settings.json");

// Read/triage replen MCP tools that are safe to auto-allow so the proactive
// footnote (replen_match) and in-session triage don't trigger a permission
// prompt every session. Deliberately EXCLUDES replen_run / replen_handoff /
// replen_feedback — those trigger pipeline runs / open PRs and should keep
// prompting for explicit consent.
const REPLEN_AUTO_ALLOW = [
  "mcp__replen__replen_match",
  "mcp__replen__replen_check_new",
  "mcp__replen__replen_analyze",
  "mcp__replen__replen_state",
  "mcp__replen__replen_record_triage",
  "mcp__replen__replen_today",
  "mcp__replen__replen_search",
  "mcp__replen__replen_starred",
  "mcp__replen__replen_status",
  "mcp__replen__replen_help",
];

// ============================================================================
// Public entry point
// ============================================================================

export async function setupMcp(token: string, base: string): Promise<void> {
  console.log(`  Wiring replen MCP into agent configs…`);

  // Pin the exact latest MCP version (deterministic; avoids npx serving a stale
  // `@^1` build and the spurious upgrade nudge that follows).
  MCP_PKG = await resolveMcpPkg();
  console.log(`  MCP version pinned to ${MCP_PKG}`);

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

  // Point the user at the onboarding sweep — the highest-leverage next step,
  // and otherwise invisible (it's a separately-invoked skill, not part of this
  // CLI flow). Without grounded, per-repo profiles the matcher leans on thin
  // server-side inference; the sweep is what makes matches genuinely relevant.
  console.log("");
  console.log("  ▸ Next: open Claude Code and run  /replen-onboard");
  console.log("    It sets Replen up across your active repos in the background —");
  console.log("    reading each one and building a tailored profile so matches are");
  console.log("    relevant, not generic. Runs autonomously; nothing to wait on.");
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
      args: ["-y", MCP_PKG],
      env: { DIGEST_BASE_URL: base, DIGEST_TOKEN: token },
    };

    const hooks = installSessionStartHook(
      (config.hooks as Record<string, unknown> | undefined) ?? {},
    );

    writeJsonAtomic(path, { ...config, mcpServers, hooks });

    // Auto-allow the read/triage tools so the proactive footnote doesn't
    // prompt every session. Best-effort: a failure here mustn't fail MCP setup.
    try {
      allowlistClaudeTools();
    } catch (e) {
      console.warn(`  ⚠ Claude Code allowlist skipped — ${(e as Error).message}`);
    }

    return { ok: true, label: "Claude Code", path, action: existed ? "updated" : "added" };
  } catch (e) {
    return { ok: false, label: "Claude Code", path, error: (e as Error).message };
  }
}

// Merge the replen read/triage tools into Claude Code's permission allowlist
// (~/.claude/settings.json → permissions.allow) so the proactive footnote +
// in-session triage run without a per-session permission prompt. Non-
// destructive: preserves existing allow entries and every other setting.
function allowlistClaudeTools(): void {
  const path = CLAUDE_SETTINGS;
  mkdirSync(dirname(path), { recursive: true });
  const config = existsSync(path) ? readJson(path) : {};
  const permissions = (config.permissions as Record<string, unknown> | undefined) ?? {};
  const existingAllow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  const allow = Array.from(new Set([...existingAllow, ...REPLEN_AUTO_ALLOW]));
  if (allow.length === existingAllow.length) return; // already fully allowlisted
  backupIfExists(path);
  writeJsonAtomic(path, { ...config, permissions: { ...permissions, allow } });
  console.log(`  ✓ Claude Code: allowlisted replen read tools (no more per-session prompts)`);
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
      args: ["-y", MCP_PKG],
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
      args: ["-y", MCP_PKG],
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
// Version-PIN the hook command. A bare `npx replen` resolves a LOCAL package
// named "replen" when one exists in cwd (e.g. the replen repo itself, whose
// server package is also "replen" and has no bin) → "could not determine
// executable to run", and the hook silently dies every session there. Pinning
// to the published version forces npx to the registry (collision-proof) and,
// because the exact version is cached, avoids the per-session `@latest`
// registry round-trip. Re-running setup refreshes the pin.
const HOOK_COMMAND = `npx --quiet replen@${cliVersion()} check-new --hook`;
// Match on the stable substring so we find/replace our hook regardless of the
// pinned version in any previously-written command.
const HOOK_MARKER = "check-new --hook";

function cliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // cli/dist
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "latest";
  } catch {
    return "latest";
  }
}

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
