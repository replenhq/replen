// `--vault` handling: let users point Replen at knowledge-graph vaults that
// live OUTSIDE a repo (a central Obsidian vault, a Graphify graph kept
// elsewhere, an ADR folder). In-repo vaults are auto-detected by the onboard
// skill; this is the escape hatch for everything that isn't sitting in the repo.
//
// Two shapes, both via `--vault`:
//   --vault ~/ObsidianVault              → GLOBAL: may cover many/all repos.
//   --vault owner/name=~/graphs/thing    → scoped to one repo (GitHub owner/name).
//
// Parsed values are validated (must be an existing directory), tilde-expanded to
// absolute paths, and merged into ~/.replen/config.json under `vaults`. The
// onboarding agent reads that config and consults these paths as grounding
// sources alongside the in-repo locations.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig, writeConfig, type Config } from "./config.js";

export type ParsedVaults = { global: string[]; byRepo: Record<string, string> };

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) return p === "~" ? homedir() : join(homedir(), p.slice(2));
  return resolve(p);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Looks like a GitHub "owner/name" (no spaces, exactly one slash, no leading ./~). */
function isRepoKey(s: string): boolean {
  return /^[^\s/]+\/[^\s/]+$/.test(s);
}

/**
 * Pull every `--vault <val>` / `--vault=<val>` out of argv. A value of the form
 * `owner/name=path` is repo-scoped; anything else is a global vault path.
 * Invalid (non-directory) paths are reported and skipped, not fatal.
 */
export function collectVaultFlags(argv: string[]): ParsedVaults {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) raw.push(argv[++i]);
    else if (a.startsWith("--vault=")) raw.push(a.slice("--vault=".length));
  }

  const out: ParsedVaults = { global: [], byRepo: {} };
  for (const val of raw) {
    // Repo-scoped only when the part BEFORE the first "=" is a repo key — so a
    // Windows-y or "="-containing path on the global side isn't misparsed.
    const eq = val.indexOf("=");
    if (eq > 0 && isRepoKey(val.slice(0, eq))) {
      const repo = val.slice(0, eq);
      const path = expandTilde(val.slice(eq + 1));
      if (!isDir(path)) {
        console.warn(`  · --vault ${repo}: not a directory, skipping: ${path}`);
        continue;
      }
      out.byRepo[repo] = path;
    } else {
      const path = expandTilde(val);
      if (!isDir(path)) {
        console.warn(`  · --vault: not a directory, skipping: ${path}`);
        continue;
      }
      out.global.push(path);
    }
  }
  return out;
}

export function hasVaultFlags(parsed: ParsedVaults): boolean {
  return parsed.global.length > 0 || Object.keys(parsed.byRepo).length > 0;
}

/**
 * Merge newly-parsed vaults into the saved config (union global paths, overwrite
 * per-repo entries). Idempotent. No-op if nothing was passed. Returns the
 * resulting vaults block for an immediate confirmation message.
 */
export async function persistVaults(parsed: ParsedVaults): Promise<Config["vaults"] | null> {
  if (!hasVaultFlags(parsed)) return null;
  const cfg = await readConfig();
  if (!cfg) return null;
  const existing = cfg.vaults ?? {};
  const global = Array.from(new Set([...(existing.global ?? []), ...parsed.global]));
  const byRepo = { ...(existing.byRepo ?? {}), ...parsed.byRepo };
  const vaults = { global, byRepo };
  await writeConfig({ ...cfg, vaults });
  return vaults;
}

export function summariseVaults(vaults: NonNullable<Config["vaults"]>): string {
  const lines: string[] = [];
  for (const g of vaults.global ?? []) lines.push(`  ✓ vault (all repos): ${g}`);
  for (const [repo, p] of Object.entries(vaults.byRepo ?? {})) lines.push(`  ✓ vault for ${repo}: ${p}`);
  return lines.join("\n");
}
