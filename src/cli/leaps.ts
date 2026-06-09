// Inspect the Leaps for a user (or one project).
//   tsx src/cli/leaps.ts --user 1
//   tsx src/cli/leaps.ts --user 1 --project acme-cv --limit 20

import { computeLeaps } from "../graph/leaps";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

async function main() {
  const userId = parseInt(arg("user", "1") ?? "1", 10);
  const scopeProject = arg("project");
  const limit = parseInt(arg("limit", "12") ?? "12", 10);
  const leaps = await computeLeaps(userId, { scopeProject, limit });
  console.log(`\nLeaps for user ${userId}${scopeProject ? ` · ${scopeProject}` : ""} (${leaps.length})\n${"=".repeat(60)}`);
  const icon = { "cross-project": "↔", "adjacency": "→", "cross-user": "✦" } as const;
  for (const l of leaps) {
    console.log(`\n${icon[l.kind]} [${l.kind}] for ${l.forProject}  (score ${l.score.toFixed(2)})`);
    if (l.candidate) console.log(`  ${l.candidate}${l.stars ? ` · ${l.stars}★` : ""}`);
    console.log(`  ${l.via}`);
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
