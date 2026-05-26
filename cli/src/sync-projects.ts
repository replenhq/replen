// Orchestrates project discovery + server registration. Tries layered
// inference strategies (cwd / Claude Code config / hardcoded roots /
// interactive prompt) until at least one git repo is found, then walks
// each root recursively to find every repo, then POSTs to
// /api/projects/bulk for upsert.
//
// Persists the user's chosen root(s) to ~/.replen/config.json so future
// `npx replen sync-projects` runs use the same set without re-prompting.

import { readConfig, writeConfig } from "./config.js";
import { discoverProjects, type DiscoveredProject, type DiscoveryResult } from "./discover-projects.js";
import {
  promptForRoot,
  rootsFromClaudeJson,
  rootsFromConfig,
  rootsFromCwdWalkUp,
  rootsFromEnv,
  rootsFromFlag,
  rootsFromHardcoded,
  type RootSource,
} from "./discover-roots.js";

type BulkResponse = {
  ok?: boolean;
  created?: number;
  updated?: number;
  total?: number;
  error?: string;
};

type SyncOptions = {
  token: string;
  base: string;
  /** Explicit --root flag values, takes top priority */
  explicitRoots?: string[];
};

export async function syncDiscoveredProjects({
  token,
  base,
  explicitRoots = [],
}: SyncOptions): Promise<{
  discovered: number;
  created: number;
  updated: number;
}> {
  const { result, source, prompted } = await resolveAndWalk(explicitRoots);

  // Tell the user what we did, regardless of outcome.
  reportDiscovery(result, source);

  if (result.projects.length === 0) {
    console.log(`  · No git repos with GitHub remotes were found. Run \`npx replen sync-projects --root <path>\` to point at a specific dir, or set REPLEN_PROJECT_ROOTS=...`);
    return { discovered: 0, created: 0, updated: 0 };
  }

  // Persist ONLY when the user came in via the interactive prompt.
  // Flags and env vars are deliberate per-invocation overrides — saving
  // them to config creates a confusing dual source of truth and, worse,
  // can lock subsequent commands (like `inject` with no args) into the
  // narrow scope the user chose for a one-off `--root` use.
  if (prompted) {
    await persistRoots(result.scannedRoots);
  }

  const payload = {
    projects: result.projects.map((p) => ({
      slug: p.slug,
      githubFullName: p.githubFullName, // null is impossible here — we filter above
      name: p.name,
      tags: p.tags,
      primaryLanguage: p.primaryLanguage ?? undefined,
    })),
  };

  let res: Response;
  try {
    res = await fetch(`${base}/api/projects/bulk`, {
      method: "POST",
      headers: {
        "x-digest-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn(`  ✗ Failed to reach ${base}/api/projects/bulk: ${(e as Error).message}`);
    console.warn(`    Skipping project registration. Run \`npx replen sync-projects\` later to retry.`);
    return { discovered: result.projects.length, created: 0, updated: 0 };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`  ✗ Project registration failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return { discovered: result.projects.length, created: 0, updated: 0 };
  }
  const body = (await res.json()) as BulkResponse;
  const created = body.created ?? 0;
  const updated = body.updated ?? 0;
  if (created > 0 || updated > 0) {
    const parts: string[] = [];
    if (created > 0) parts.push(`${created} new`);
    if (updated > 0) parts.push(`${updated} updated`);
    console.log(`  ✓ Registered with Replen: ${parts.join(", ")}`);
  } else {
    console.log(`  · All ${result.projects.length} projects already up to date with Replen`);
  }
  return { discovered: result.projects.length, created, updated };
}

/**
 * Try discovery strategies in priority order. The first strategy that
 * yields ≥1 project's worth of repos wins; if none do, falls back to
 * the interactive prompt.
 *
 * Returns the walked result, the strategy that supplied the roots,
 * and a flag indicating whether the interactive prompt was used.
 */
async function resolveAndWalk(explicitRoots: string[]): Promise<{
  result: DiscoveryResult;
  source: RootSource;
  prompted: boolean;
}> {
  // Strategies that take precedence and short-circuit on hit.
  const ordered: Array<{ source: RootSource; roots: () => Promise<string[]> | string[] }> = [
    { source: "flag", roots: () => rootsFromFlag(explicitRoots) },
    { source: "env", roots: () => rootsFromEnv() },
    { source: "config", roots: () => rootsFromConfig() },
  ];
  for (const { source, roots } of ordered) {
    const r = await roots();
    if (r.length > 0) {
      const result = discoverProjects(r);
      return { result, source, prompted: false };
    }
  }

  // Inference strategies combine: walk the union of cwd / Claude / hardcoded.
  // Any one of them surfacing repos is enough; we union to maximise the
  // chance of catching the user's repos no matter where they live.
  const inferred = Array.from(new Set([
    ...rootsFromCwdWalkUp(),
    ...rootsFromClaudeJson(),
    ...rootsFromHardcoded(),
  ]));
  if (inferred.length > 0) {
    const result = discoverProjects(inferred);
    if (result.projects.length > 0) {
      return { result, source: pickInferredSource(inferred), prompted: false };
    }
    // Inferred roots existed but contained no GitHub repos — fall
    // through to prompt rather than reporting empty.
  }

  // Last resort: ask.
  const chosen = await promptForRoot();
  if (!chosen) {
    return {
      result: { projects: [], nonGithubSkipped: 0, scannedRoots: inferred },
      source: "prompt",
      prompted: true,
    };
  }
  const result = discoverProjects([chosen]);
  return { result, source: "prompt", prompted: true };
}

/**
 * If the inferred-roots union turned up projects, pick the most
 * specific source for the user-facing message. Order matches priority:
 * cwd is most specific, hardcoded least.
 */
function pickInferredSource(roots: string[]): RootSource {
  if (rootsFromCwdWalkUp().some((r) => roots.includes(r))) return "cwd";
  if (rootsFromClaudeJson().some((r) => roots.includes(r))) return "claude-json";
  return "hardcoded";
}

function reportDiscovery(result: DiscoveryResult, source: RootSource): void {
  const sourceLabel: Record<RootSource, string> = {
    flag: "from --root flag",
    env: "from REPLEN_PROJECT_ROOTS env",
    config: "from saved config",
    cwd: "via cwd walk-up",
    "claude-json": "via Claude Code's tracked projects",
    hardcoded: "via conventional ~/github, ~/code, ~/projects",
    prompt: "you specified",
  };
  console.log(`  · Scanning ${result.scannedRoots.length} root(s) (${sourceLabel[source]}):`);
  for (const r of result.scannedRoots.slice(0, 5)) {
    console.log(`      ${r}`);
  }
  if (result.scannedRoots.length > 5) {
    console.log(`      … and ${result.scannedRoots.length - 5} more`);
  }
  if (result.projects.length === 0) return;

  console.log(`  ✓ Found ${result.projects.length} git repo(s) with GitHub remotes:`);
  for (const p of result.projects.slice(0, 5)) {
    const sampleTags = p.tags.slice(0, 3).join(", ") || "(no auto-tags)";
    const localHint = pathHint(p);
    console.log(`      • ${p.githubFullName} ${localHint}  →  ${sampleTags}`);
  }
  if (result.projects.length > 5) {
    console.log(`      … and ${result.projects.length - 5} more`);
  }
  if (result.nonGithubSkipped > 0) {
    console.log(`  · Skipped ${result.nonGithubSkipped} local repo(s) without a GitHub remote (nothing to match against)`);
  }
}

/** Render "(at ~/projects/drone)" only when the dirname differs from the
 * repo name — i.e. only when there's actual signal worth showing. */
function pathHint(p: DiscoveredProject): string {
  const repoName = (p.githubFullName ?? "").split("/")[1] ?? "";
  const dirName = p.localPath.split("/").pop() ?? "";
  if (!repoName || dirName.toLowerCase() === repoName.toLowerCase()) return "";
  // Compress home prefix for readability.
  const home = process.env.HOME ?? "";
  const display = home && p.localPath.startsWith(home) ? "~" + p.localPath.slice(home.length) : p.localPath;
  return ` (at ${display})`;
}

async function persistRoots(roots: string[]): Promise<void> {
  const cfg = await readConfig();
  if (!cfg) return;
  // Don't overwrite if config already had a roots list — leave the
  // user's previous choice alone unless they re-prompt.
  if (cfg.projectRoots && cfg.projectRoots.length > 0) return;
  await writeConfig({ ...cfg, projectRoots: roots });
}

// Returns just the discovered list without sending. Useful for the
// CLI's `replen list-projects` subcommand (preview mode).
export async function previewDiscovery(explicitRoots: string[] = []): Promise<DiscoveryResult> {
  const { result } = await resolveAndWalk(explicitRoots);
  return result;
}
