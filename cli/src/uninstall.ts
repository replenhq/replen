// `npx replen uninstall` — reverse every local change `npx replen` made,
// interactively and per-category, so a tester (or anyone) can cleanly back
// out. The inverse of mcp-setup.ts + skill-install.ts + inject-instruction.ts.
//
// Design constraints (deliberate):
//   - INTERACTIVE BY DEFAULT. Every destructive category asks its own
//     y/N question, and the default is always NO. There is no single
//     "nuke everything" keystroke — the user has to acknowledge each
//     class of change so they understand what's being removed.
//   - LOCAL ONLY. This touches the user's machine; it does NOT delete
//     server-side data (project profiles, capabilities, matches). There
//     is no account-delete endpoint yet — we tell the user how to request
//     that separately rather than pretending we did it.
//   - BACKUP BEFORE WRITE. Any host config we edit gets a timestamped
//     `.bak` first, mirroring mcp-setup's contract, so even an unwanted
//     removal is recoverable.
//   - Per-repo doc edits are git-tracked, so stripping the Replen section
//     shows up as a normal diff the user can review or revert.
//
// Flags:
//   --yes / -y   Skip the per-category prompts (scripted / CI use). Still
//                prints exactly what it removed.
//   --dry-run    Show what WOULD be removed, change nothing.
//   --root PATH  Extra root(s) to scan for repos with injected doc blocks
//                (same semantics as `sync-projects --root`).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { configPath } from "./config.js";

const SERVER_NAME = "replen";

const CLAUDE_CONFIG = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const GEMINI_CONFIG = join(homedir(), ".gemini", "settings.json");
const CLAUDE_SKILLS = join(homedir(), ".claude", "skills");
const REPLEN_DIR = join(homedir(), ".replen");

// User-level (global) instruction files written by inject-instruction.ts so
// activation reaches every repo. CC rule file is Replen-owned (delete whole);
// Codex/Gemini are shared (strip the section, or delete if we created the file).
const GLOBAL_CC_RULE = join(homedir(), ".claude", "rules", "replen.md");
const GLOBAL_CODEX = join(homedir(), ".codex", "AGENTS.md");
const GLOBAL_CODEX_OVERRIDE = join(homedir(), ".codex", "AGENTS.override.md");
const GLOBAL_GEMINI = join(homedir(), ".gemini", "GEMINI.md");

// Must match mcp-setup.ts: the tools it adds to permissions.allow and the
// substring marker on the SessionStart hook command.
const REPLEN_AUTO_ALLOW_PREFIX = "mcp__replen__";
const HOOK_MARKER = "check-new --hook";

// Must match inject-instruction.ts.
const SECTION_HEADER = "## Replen integration";
const MARKER_RE = /<!--\s*replen-integration:\s*v(\d+)\s*-->/;
// The auto-generated stub header we write into a freshly-created doc, so we
// can recognise a file that exists ONLY because Replen created it.
const STUB_HINT = "the Replen integration section below is auto-managed";

const SKILL_DIRS = ["replen", "replen-onboard"];

type Opts = { yes: boolean; dryRun: boolean; explicitRoots: string[] };

export async function runUninstall(argv: string[]): Promise<void> {
  const opts: Opts = {
    yes: argv.includes("--yes") || argv.includes("-y"),
    dryRun: argv.includes("--dry-run"),
    explicitRoots: collectRoots(argv),
  };

  banner(opts);

  // Top-level gate. Even with the per-category prompts below, the user
  // confirms once up front that they understand what "uninstall" means.
  if (!opts.yes && !opts.dryRun) {
    const go = await confirm("Continue with uninstall?", false);
    if (!go) {
      console.log("\n  Nothing changed. Replen is still installed.");
      return;
    }
  }

  await removeMcpWiring(opts);
  await removeSkills(opts);
  await removeDocBlocks(opts);
  await removeGlobalInstructions(opts);
  await removeLocalConfig(opts);

  console.log("");
  if (opts.dryRun) {
    console.log("  Dry run — nothing was changed. Re-run without --dry-run to apply.");
  } else {
    console.log("  Done. Restart Claude Code / Codex / Gemini to drop the MCP server.");
  }
  console.log("");
  console.log("  Note: this removed Replen from THIS machine only. Your server-side");
  console.log("  profile (project capabilities, match history) still exists. To delete");
  console.log("  that too, sign in at https://app.replen.dev and use account deletion,");
  console.log("  or email support@replen.dev to request a full purge.");
}

// ============================================================================
// Category 1 — MCP wiring across the three host configs + the allowlist + hook
// ============================================================================

async function removeMcpWiring(opts: Opts): Promise<void> {
  // Probe what's actually present so we don't prompt about nothing.
  const targets: Array<{ label: string; path: string; present: () => boolean; remove: () => void }> = [
    {
      label: "Claude Code MCP + SessionStart hook",
      path: CLAUDE_CONFIG,
      present: () => jsonHasServer(CLAUDE_CONFIG) || jsonHasHook(CLAUDE_CONFIG),
      remove: () => stripClaudeConfig(),
    },
    {
      label: "Claude Code tool allowlist",
      path: CLAUDE_SETTINGS,
      present: () => jsonHasAllow(CLAUDE_SETTINGS),
      remove: () => stripClaudeAllowlist(),
    },
    {
      label: "Codex MCP server",
      path: CODEX_CONFIG,
      present: () => tomlHasServer(CODEX_CONFIG),
      remove: () => stripTomlServer(CODEX_CONFIG),
    },
    {
      label: "Gemini CLI MCP server",
      path: GEMINI_CONFIG,
      present: () => jsonHasServer(GEMINI_CONFIG),
      remove: () => stripJsonServer(GEMINI_CONFIG),
    },
  ];

  const found = targets.filter((t) => safe(t.present));
  if (found.length === 0) {
    console.log("\n  ① MCP wiring — none found, skipping.");
    return;
  }

  console.log("\n  ① MCP wiring found in:");
  for (const t of found) console.log(`       • ${t.label}  (${t.path})`);

  if (!(await gate(opts, "Remove the replen MCP entries above?"))) {
    console.log("       · kept.");
    return;
  }
  if (opts.dryRun) return;

  for (const t of found) {
    try {
      t.remove();
      console.log(`       ✓ removed: ${t.label}`);
    } catch (e) {
      console.warn(`       ⚠ ${t.label}: ${(e as Error).message}`);
    }
  }
}

// ============================================================================
// Category 2 — installed skills
// ============================================================================

async function removeSkills(opts: Opts): Promise<void> {
  const present = SKILL_DIRS.map((n) => join(CLAUDE_SKILLS, n)).filter((p) => existsSync(p));
  if (present.length === 0) {
    console.log("\n  ② Skills — none found, skipping.");
    return;
  }
  console.log("\n  ② Installed skills:");
  for (const p of present) console.log(`       • ${p}`);
  if (!(await gate(opts, "Remove these skill directories?"))) {
    console.log("       · kept.");
    return;
  }
  if (opts.dryRun) return;
  for (const p of present) {
    try {
      rmSync(p, { recursive: true, force: true });
      console.log(`       ✓ removed: ${basename(p)}`);
    } catch (e) {
      console.warn(`       ⚠ ${p}: ${(e as Error).message}`);
    }
  }
}

// ============================================================================
// Category 3 — the "## Replen integration" block in per-repo doc files
// ============================================================================

async function removeDocBlocks(opts: Opts): Promise<void> {
  let repos: string[] = [];
  try {
    const { previewDiscovery } = await import("./sync-projects.js");
    const result = await previewDiscovery(opts.explicitRoots);
    repos = result.projects.map((p) => p.localPath);
  } catch {
    repos = [];
  }

  // Find every doc file under those repos that carries our section.
  const hits: Array<{ file: string; stubOnly: boolean }> = [];
  for (const repo of repos) {
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      const file = join(repo, fileName);
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!hasReplenSection(text)) continue;
      hits.push({ file, stubOnly: isStubOnly(text) });
    }
  }

  if (hits.length === 0) {
    console.log("\n  ③ Per-repo doc edits — none found, skipping.");
    if (repos.length === 0) {
      console.log("       (no repos discovered — pass --root PATH if your code lives somewhere non-conventional)");
    }
    return;
  }

  console.log(`\n  ③ "${SECTION_HEADER}" blocks found in ${hits.length} file(s):`);
  for (const h of hits.slice(0, 10)) {
    console.log(`       • ${h.file}${h.stubOnly ? "   (Replen-created — will delete whole file)" : "   (strip section, keep your content)"}`);
  }
  if (hits.length > 10) console.log(`       … and ${hits.length - 10} more`);
  console.log("       These are git-tracked, so the change shows as a normal diff you can review.");

  if (!(await gate(opts, "Strip the Replen section from these files?"))) {
    console.log("       · kept.");
    return;
  }
  if (opts.dryRun) return;

  for (const h of hits) {
    try {
      if (h.stubOnly) {
        rmSync(h.file, { force: true });
        console.log(`       ✓ deleted (Replen-created): ${h.file}`);
      } else {
        writeFileSync(h.file, stripReplenSection(readFileSync(h.file, "utf8")));
        console.log(`       ✓ stripped section: ${h.file}`);
      }
    } catch (e) {
      console.warn(`       ⚠ ${h.file}: ${(e as Error).message}`);
    }
  }
}

// ============================================================================
// Category 4. The user-level (global) instruction files
// ============================================================================

async function removeGlobalInstructions(opts: Opts): Promise<void> {
  type Hit = { file: string; deleteWhole: boolean };
  const hits: Hit[] = [];
  // CC rule file is Replen-owned (we create the whole file): delete it entirely.
  if (existsSync(GLOBAL_CC_RULE)) {
    try {
      if (hasReplenSection(readFileSync(GLOBAL_CC_RULE, "utf8"))) hits.push({ file: GLOBAL_CC_RULE, deleteWhole: true });
    } catch { /* ignore unreadable */ }
  }
  // Codex + Gemini are shared files: strip our section, or delete if we created it.
  for (const file of [GLOBAL_CODEX, GLOBAL_CODEX_OVERRIDE, GLOBAL_GEMINI]) {
    if (!existsSync(file)) continue;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (!hasReplenSection(text)) continue;
    hits.push({ file, deleteWhole: isStubOnly(text) });
  }
  if (hits.length === 0) {
    console.log("\n  ④ Global instruction files (~/.claude/rules, ~/.codex, ~/.gemini): none found, skipping.");
    return;
  }
  console.log(`\n  ④ Global Replen instruction files (${hits.length}):`);
  for (const h of hits) {
    console.log(`       • ${h.file}${h.deleteWhole ? "   (Replen-created, will delete)" : "   (strip section, keep your content)"}`);
  }
  if (!(await gate(opts, "Remove the global Replen instruction from these files?"))) {
    console.log("       · kept.");
    return;
  }
  if (opts.dryRun) return;
  for (const h of hits) {
    try {
      if (h.deleteWhole) {
        rmSync(h.file, { force: true });
        console.log(`       ✓ deleted: ${h.file}`);
      } else {
        writeFileSync(h.file, stripReplenSection(readFileSync(h.file, "utf8")));
        console.log(`       ✓ stripped section: ${h.file}`);
      }
    } catch (e) {
      console.warn(`       ⚠ ${h.file}: ${(e as Error).message}`);
    }
  }
}

// ============================================================================
// Category 5. ~/.replen (auth token + saved roots + Atlas vault export)
// ============================================================================

async function removeLocalConfig(opts: Opts): Promise<void> {
  if (!existsSync(REPLEN_DIR)) {
    console.log("\n  ⑤ Local config (~/.replen): none found, skipping.");
    return;
  }
  const cfg = existsSync(configPath());
  const atlas = existsSync(join(REPLEN_DIR, "atlas"));
  console.log("\n  ④ Local Replen directory:");
  console.log(`       • ${REPLEN_DIR}`);
  if (cfg) console.log("         - config.json (auth token + saved project roots)");
  if (atlas) console.log("         - atlas/ (your exported knowledge-graph vault)");
  if (!(await gate(opts, "Remove ~/.replen entirely?"))) {
    console.log("       · kept (you stay signed in).");
    return;
  }
  if (opts.dryRun) return;
  try {
    rmSync(REPLEN_DIR, { recursive: true, force: true });
    console.log("       ✓ removed: ~/.replen");
  } catch (e) {
    console.warn(`       ⚠ ${REPLEN_DIR}: ${(e as Error).message}`);
  }
}

// ============================================================================
// Host-config mutation helpers (mirror mcp-setup's read/backup/atomic-write)
// ============================================================================

function jsonHasServer(path: string): boolean {
  const c = readJson(path);
  const servers = c.mcpServers as Record<string, unknown> | undefined;
  return !!servers && SERVER_NAME in servers;
}

function jsonHasHook(path: string): boolean {
  const c = readJson(path);
  const ss = (c.hooks as Record<string, unknown> | undefined)?.SessionStart as
    | Array<{ hooks?: Array<{ command?: string }> }>
    | undefined;
  if (!Array.isArray(ss)) return false;
  return ss.some((e) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(HOOK_MARKER)));
}

function jsonHasAllow(path: string): boolean {
  const c = readJson(path);
  const allow = (c.permissions as Record<string, unknown> | undefined)?.allow;
  return Array.isArray(allow) && allow.some((a) => typeof a === "string" && a.startsWith(REPLEN_AUTO_ALLOW_PREFIX));
}

function tomlHasServer(path: string): boolean {
  const c = readTomlSafe(path);
  const servers = c.mcp_servers as Record<string, unknown> | undefined;
  return !!servers && SERVER_NAME in servers;
}

// Remove mcpServers.replen AND our SessionStart hook from ~/.claude.json.
function stripClaudeConfig(): void {
  const c = readJson(CLAUDE_CONFIG);
  const servers = (c.mcpServers as Record<string, unknown> | undefined) ?? {};
  delete servers[SERVER_NAME];

  const hooks = (c.hooks as Record<string, unknown> | undefined) ?? {};
  const ss = (hooks.SessionStart as Array<{ hooks?: Array<{ command?: string }> }> | undefined) ?? [];
  const cleanedSS = ss.filter(
    (e) => !(e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(HOOK_MARKER)),
  );

  const nextHooks: Record<string, unknown> = { ...hooks };
  if (cleanedSS.length > 0) nextHooks.SessionStart = cleanedSS;
  else delete nextHooks.SessionStart;

  const next: Record<string, unknown> = { ...c, mcpServers: servers };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  if (Object.keys(servers).length === 0) delete (next as { mcpServers?: unknown }).mcpServers;

  backupIfExists(CLAUDE_CONFIG);
  writeJsonAtomic(CLAUDE_CONFIG, next);
}

function stripClaudeAllowlist(): void {
  const c = readJson(CLAUDE_SETTINGS);
  const permissions = (c.permissions as Record<string, unknown> | undefined) ?? {};
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  const kept = allow.filter((a) => !(typeof a === "string" && a.startsWith(REPLEN_AUTO_ALLOW_PREFIX)));
  const nextPerms: Record<string, unknown> = { ...permissions };
  if (kept.length > 0) nextPerms.allow = kept;
  else delete nextPerms.allow;
  const next: Record<string, unknown> = { ...c };
  if (Object.keys(nextPerms).length > 0) next.permissions = nextPerms;
  else delete next.permissions;
  backupIfExists(CLAUDE_SETTINGS);
  writeJsonAtomic(CLAUDE_SETTINGS, next);
}

function stripJsonServer(path: string): void {
  const c = readJson(path);
  const servers = (c.mcpServers as Record<string, unknown> | undefined) ?? {};
  delete servers[SERVER_NAME];
  const next: Record<string, unknown> = { ...c, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete (next as { mcpServers?: unknown }).mcpServers;
  backupIfExists(path);
  writeJsonAtomic(path, next);
}

function stripTomlServer(path: string): void {
  const c = readTomlSafe(path);
  const servers = (c.mcp_servers as Record<string, unknown> | undefined) ?? {};
  delete servers[SERVER_NAME];
  const next: Record<string, unknown> = { ...c, mcp_servers: servers };
  if (Object.keys(servers).length === 0) delete (next as { mcp_servers?: unknown }).mcp_servers;
  backupIfExists(path);
  // smol-toml doesn't preserve comments/formatting on re-serialise; warn if the
  // file had comments so their loss on uninstall isn't silent (a .bak is taken).
  if (existsSync(path) && /^\s*#/m.test(readFileSync(path, "utf8"))) {
    console.warn(`  ⚠ ${path}: comments/formatting in this TOML aren't preserved (a .bak was saved next to it).`);
  }
  writeTomlAtomic(path, next);
}

// ============================================================================
// Doc-section helpers (mirror inject-instruction's section anchoring)
// ============================================================================

function hasReplenSection(text: string): boolean {
  return text.split("\n").some((l) => l.trim() === SECTION_HEADER);
}

// A file is "stub only" if Replen created it: it carries our generated stub
// hint AND contains nothing but the header + the Replen section. Removing the
// section would leave an empty husk, so we delete the whole file instead.
function isStubOnly(text: string): boolean {
  if (!text.includes(STUB_HINT)) return false;
  const stripped = stripReplenSection(text).trim();
  // After removing the section, all that's left is the auto-generated H1 +
  // stub comment. If there's no other prose, treat it as Replen-owned.
  const meaningful = stripped
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("# ") && !l.trim().startsWith("<!--"))
    .join("")
    .trim();
  return meaningful.length === 0;
}

// Remove the `## Replen integration` block: from its H2 header to the next H2
// (not H3+) or EOF. Mirrors replaceSection() in inject-instruction.ts but
// deletes rather than replaces. Collapses any duplicate blocks too.
function stripReplenSection(text: string): string {
  let out = text;
  // Loop until no section remains (defends against legacy duplicate blocks).
  // Bounded to avoid any pathological non-progress.
  for (let guard = 0; guard < 10; guard++) {
    const lines = out.split("\n");
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === SECTION_HEADER) {
        start = i;
        break;
      }
    }
    if (start === -1) break;
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (lines[j].startsWith("## ") && !lines[j].startsWith("### ")) {
        end = j;
        break;
      }
    }
    const before = lines.slice(0, start).join("\n").replace(/\n+$/, "");
    const after = end < lines.length ? lines.slice(end).join("\n") : "";
    out = (before + (after ? "\n\n" + after : "\n")).replace(/\n{3,}/g, "\n\n");
  }
  void MARKER_RE; // marker presence already implied by header; kept for parity
  return out.replace(/\s+$/, "") + "\n";
}

// ============================================================================
// File primitives
// ============================================================================

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function readTomlSafe(path: string): Record<string, unknown> {
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

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

function backupIfExists(path: string): void {
  if (!existsSync(path)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak.${ts}`;
  // The backed-up config can carry tokens; keep it 0600 like the atomic
  // write above, not the umask default (typically world-readable 0644).
  writeFileSync(backup, readFileSync(path), { mode: 0o600 });
  try {
    chmodSync(backup, 0o600);
  } catch {
    /* best-effort */
  }
}

// ============================================================================
// CLI plumbing
// ============================================================================

function banner(opts: Opts): void {
  console.log("");
  console.log("  Replen uninstall — removes Replen's LOCAL footprint from this machine.");
  console.log("  You'll be asked before each category; nothing is removed without a yes.");
  if (opts.dryRun) console.log("  (--dry-run: previewing only, no changes)");
  console.log("");
  console.log("  In scope:  MCP wiring (Claude/Codex/Gemini), the /replen skills, the");
  console.log("             per-repo AND user-level \"## Replen integration\" blocks, and ~/.replen.");
  console.log("  NOT in scope: server-side profiles & match history (see note at the end).");
}

// Per-category gate. --yes bypasses (scripted). Default is NO.
async function gate(opts: Opts, question: string): Promise<boolean> {
  if (opts.dryRun) return true; // show what would happen, but caller no-ops
  if (opts.yes) return true;
  return confirm(question, false);
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-interactive + no --yes ⇒ refuse to delete
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`       ${question} ${hint} `)).trim().toLowerCase();
    if (ans === "") return defaultYes;
    return ans === "y" || ans === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function collectRoots(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) out.push(argv[++i]);
    else if (argv[i].startsWith("--root=")) out.push(argv[i].slice("--root=".length));
  }
  return out;
}

function safe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}
