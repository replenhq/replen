#!/usr/bin/env node
// Prepublish guard: the shipped skill bundle (cli/extras/skills/replen/SKILL.md)
// MUST match the repo source (skills/replen/SKILL.md). There's no automated copy
// step between them, so they have drifted silently before — the published skill
// once lagged the source by the whole solid-candidate triage feature. This fails
// the publish loudly if they differ, with the one command to resync.
//
// Runs from the cli/ package dir (npm prepublishOnly cwd).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // cli/scripts
const cliRoot = join(here, "..");                      // cli/
const repoRoot = join(cliRoot, "..");                  // repo root

// Each entry: the bundled copy that ships, and the repo source it must mirror.
const PAIRS = [
  {
    source: join(repoRoot, "skills", "replen", "SKILL.md"),
    bundle: join(cliRoot, "extras", "skills", "replen", "SKILL.md"),
  },
];

let drift = false;
for (const { source, bundle } of PAIRS) {
  let s, b;
  try {
    s = readFileSync(source, "utf8");
  } catch (e) {
    console.error(`✗ skill-sync: cannot read source ${source}: ${e.message}`);
    drift = true;
    continue;
  }
  try {
    b = readFileSync(bundle, "utf8");
  } catch (e) {
    console.error(`✗ skill-sync: cannot read bundle ${bundle}: ${e.message}`);
    drift = true;
    continue;
  }
  if (s !== b) {
    drift = true;
    console.error(`✗ skill-sync: bundle is OUT OF SYNC with source.`);
    console.error(`    source: ${source}`);
    console.error(`    bundle: ${bundle}`);
    console.error(`    Resync before publishing:`);
    console.error(`      cp "${source}" "${bundle}"`);
  }
}

if (drift) {
  console.error("\nRefusing to publish a stale skill bundle. Resync and retry.");
  process.exit(1);
}
console.log("✓ skill-sync: bundle matches source");
