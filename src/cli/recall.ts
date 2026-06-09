// Inspect Recall results.
//   tsx src/cli/recall.ts --user 1 --q "satellite imagery"
//   tsx src/cli/recall.ts --user 1 --verdict port

import { recall } from "../graph/recall";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

async function main() {
  const userId = parseInt(arg("user", "1") ?? "1", 10);
  const query = arg("q", "") ?? "";
  const verdict = arg("verdict");
  const r = await recall(userId, { query, verdict, limit: 8 });
  console.log(`\nRecall: "${r.query}"${verdict ? ` [verdict=${verdict}]` : ""}\n${"=".repeat(56)}`);
  console.log(`\nCapabilities you have:`);
  for (const c of r.capabilities) console.log(`  ${c.capability.padEnd(28)} {${c.provenance}}  ← ${c.projects.join(", ")}`);
  console.log(`\nDecisions on record:`);
  for (const d of r.decisions) console.log(`  ${d.verdict.toUpperCase().padEnd(6)} ${d.repo}${d.project ? ` (${d.project})` : ""}${d.reasonCode ? ` [${d.reasonCode}]` : ""}\n         ${d.oneLine ?? ""}`);
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
