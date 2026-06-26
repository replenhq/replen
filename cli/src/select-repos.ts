// Onboarding repo-scope choice. Run once during `npx replen`, AFTER auth
// and BEFORE we wire MCP / inject docs / register projects, so the user
// decides up front which of their repos Replen works on.
//
// Default is ALL — the cross-repo view (Atlas, Recall, far-away matches)
// is the product's value, and most users want everything in. But a
// cautious first-time user (or anyone testing) can scope to a subset, or
// opt out entirely, and that choice gates BOTH server registration AND
// the per-repo CLAUDE.md/AGENTS.md/GEMINI.md doc edits — Replen never
// touches a repo they didn't pick.
//
// Returns `{ onlyRepos }`:
//   - undefined  → "all" (no scope restriction; the default everywhere)
//   - string[]   → exactly these absolute localPaths (may be empty = none)

import { createInterface } from "node:readline/promises";
import { previewDiscovery } from "./sync-projects.js";

export type RepoScope = { onlyRepos?: string[] };

export async function chooseRepoScope(): Promise<RepoScope> {
  // Discover the same set inject + sync will see.
  let projects: Array<{ githubFullName: string | null; localPath: string }> = [];
  try {
    const result = await previewDiscovery([]);
    projects = result.projects;
  } catch {
    return {}; // discovery failed — fall back to default (all)
  }

  // Nothing to choose, or non-interactive (CI / hook / piped): keep the
  // default. We never block onboarding on a prompt that can't be answered.
  if (projects.length === 0) return {};
  if (!process.stdin.isTTY) return {};
  // A single repo isn't worth a selection menu — just include it.
  if (projects.length === 1) return {};

  const home = process.env.HOME ?? "";
  const label = (p: { githubFullName: string | null; localPath: string }) => {
    const disp = home && p.localPath.startsWith(home) ? "~" + p.localPath.slice(home.length) : p.localPath;
    return p.githubFullName ? `${p.githubFullName}  (${disp})` : disp;
  };

  console.log("");
  console.log(`  Replen found ${projects.length} repos it can work with.`);
  console.log("  Replen works best across all of them — that's how it spots a tool you");
  console.log("  use in one project that fits another. You can also start with a subset.");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choice = (
      await rl.question("  Include  [A]ll (default) · [s]elect a subset · [n]one for now? ")
    )
      .trim()
      .toLowerCase();

    if (choice === "" || choice === "a" || choice === "all") {
      return {}; // all
    }
    if (choice === "n" || choice === "none") {
      console.log("  · None for now. Run `npx replen sync-projects` anytime to add them.");
      return { onlyRepos: [] };
    }

    // Subset: show the numbered list and parse an inclusion spec.
    console.log("");
    projects.forEach((p, i) => console.log(`    ${String(i + 1).padStart(2)}. ${label(p)}`));
    console.log("");
    const spec = (
      await rl.question("  Numbers to include (e.g. 1,3,5 or 1-4,7), blank = all: ")
    ).trim();

    if (spec === "") return {}; // blank ⇒ all
    const picked = parseSelection(spec, projects.length);
    if (picked.size === 0) {
      console.log("  · Nothing parsed from that — including all.");
      return {};
    }
    const onlyRepos = projects.filter((_, i) => picked.has(i + 1)).map((p) => p.localPath);
    console.log(`  ✓ Including ${onlyRepos.length} of ${projects.length} repos.`);
    return { onlyRepos };
  } catch {
    return {}; // any prompt error ⇒ safe default (all)
  } finally {
    rl.close();
  }
}

// Parse "1,3,5" / "1-4" / "2-3,7" into a set of 1-based indices, clamped
// to [1, max]. Tolerant of spaces and stray separators.
export function parseSelection(spec: string, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let lo = parseInt(range[1], 10);
      let hi = parseInt(range[2], 10);
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let n = lo; n <= hi; n++) if (n >= 1 && n <= max) out.add(n);
      continue;
    }
    const single = token.match(/^\d+$/);
    if (single) {
      const n = parseInt(token, 10);
      if (n >= 1 && n <= max) out.add(n);
    }
  }
  return out;
}
