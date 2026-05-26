// Layered project-root discovery. Tries cheap inference first, falls back
// to interactive prompt if nothing works. Result is one or more root dirs
// that the recursive walker in discover-projects.ts will then scan for
// git repos.
//
// Order (cheapest / most-targeted first):
//   1. Explicit --root flag(s)               → user-specified
//   2. REPLEN_PROJECT_ROOTS env var          → scripted / dotfiles
//   3. Saved ~/.replen/config.json roots     → previously confirmed
//   4. cwd walk-up                           → "I'm in a repo right now"
//   5. ~/.claude.json mining                 → "I use Claude Code regularly"
//   6. Hardcoded ~/github, ~/code, ~/projects → conventional layout
//   7. Interactive prompt                    → ask the user directly
//
// The orchestration in sync-projects.ts tries strategies in order and
// keeps going until at least one git repo is found, then stops looking.

import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readConfig } from "./config.js";

export type RootSource =
  | "flag"
  | "env"
  | "config"
  | "cwd"
  | "claude-json"
  | "hardcoded"
  | "prompt";

export type DiscoveredRoots = {
  roots: string[];
  source: RootSource;
};

/** From explicit `--root <path>` CLI flag(s), or empty if not passed. */
export function rootsFromFlag(flagValues: string[]): string[] {
  return flagValues.map(expandTilde).filter(existsAndIsDir);
}

/** From `REPLEN_PROJECT_ROOTS` env var (colon-separated). */
export function rootsFromEnv(): string[] {
  const env = process.env.REPLEN_PROJECT_ROOTS;
  if (!env) return [];
  return env.split(":").map((s) => s.trim()).filter(Boolean).map(expandTilde).filter(existsAndIsDir);
}

/** From the user's persisted ~/.replen/config.json `projectRoots`. */
export async function rootsFromConfig(): Promise<string[]> {
  const cfg = await readConfig();
  if (!cfg?.projectRoots?.length) return [];
  return cfg.projectRoots.map(expandTilde).filter(existsAndIsDir);
}

/**
 * If `npx replen` was invoked from inside a git repo (or one of its
 * subdirs), walk up to find the repo root, then return its parent dir
 * as a candidate root. This catches the common "I'm sitting in one of
 * my projects when I install Replen" case.
 *
 * Stops at `homedir()` and at `/` to avoid walking into system dirs.
 */
export function rootsFromCwdWalkUp(): string[] {
  const cwd = process.cwd();
  const home = homedir();
  let dir = cwd;
  // Walk up until we find a .git/ or hit home/root.
  while (dir !== "/" && dir !== home && dir.length > 1) {
    if (existsSync(join(dir, ".git"))) {
      const parent = dirname(dir);
      // Only suggest the parent if it's still inside home — never offer
      // "/" or anything above $HOME as a scan root.
      if (parent.startsWith(home) && parent !== home) return [parent];
      return [];
    }
    dir = dirname(dir);
  }
  return [];
}

/**
 * Read ~/.claude.json (Claude Code's per-user config) and extract the
 * project cwds it tracks. Group by parent dir. Return parents that
 * contain ≥2 Claude Code projects — these are very likely the user's
 * actual repo roots.
 *
 * Why this is high-signal: Claude Code only adds an entry when the user
 * opens it inside a real project, so the cwd list is curated by their
 * actual usage. Far more accurate than guessing dir names.
 */
export function rootsFromClaudeJson(): string[] {
  const claudePath = join(homedir(), ".claude.json");
  if (!existsSync(claudePath)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(claudePath, "utf8"));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const projects = (data as { projects?: Record<string, unknown> }).projects;
  if (!projects || typeof projects !== "object") return [];

  const parentCounts = new Map<string, number>();
  for (const path of Object.keys(projects)) {
    if (!path.startsWith("/")) continue;
    const parent = dirname(path);
    if (!parent.startsWith(homedir())) continue;
    parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
  }
  return Array.from(parentCounts.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([parent]) => parent)
    .filter(existsAndIsDir);
}

/** Conventional layout: ~/github, ~/code, ~/projects. */
export function rootsFromHardcoded(): string[] {
  return ["github", "code", "projects", "Code", "Projects", "dev", "src", "work"]
    .map((n) => join(homedir(), n))
    .filter(existsAndIsDir);
}

/**
 * Last-resort interactive prompt. Asks the user where they keep their
 * code, with a sensible default. Returns null if the user is in a
 * non-interactive context (stdin not a TTY) or hits Ctrl-C.
 */
export async function promptForRoot(): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const home = homedir();
  // Suggest the most common parent of any folder we know about, falling
  // back to home itself.
  const suggestion = pickPromptSuggestion() ?? home;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\n  Where do you keep your code? [${suggestion}]: `)).trim();
    const chosen = answer || suggestion;
    const expanded = expandTilde(chosen);
    if (!existsAndIsDir(expanded)) {
      console.warn(`  ✗ Not a directory: ${expanded}`);
      return null;
    }
    return expanded;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

function pickPromptSuggestion(): string | null {
  const fromCwd = rootsFromCwdWalkUp();
  if (fromCwd[0]) return fromCwd[0];
  const fromClaude = rootsFromClaudeJson();
  if (fromClaude[0]) return fromClaude[0];
  const fromHard = rootsFromHardcoded();
  if (fromHard[0]) return fromHard[0];
  return null;
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return p === "~" ? homedir() : join(homedir(), p.slice(2));
  }
  return resolve(p);
}

function existsAndIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
