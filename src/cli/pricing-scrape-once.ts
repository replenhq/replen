// One-shot pricing scrape, outside the cron. For testing and manual kicks.
//
// Usage:
//   tsx src/cli/pricing-scrape-once.ts                  # the due batch
//   tsx src/cli/pricing-scrape-once.ts --match supabase # one vendor/tool
//   tsx src/cli/pricing-scrape-once.ts --limit 10 --force

import { runPricingScrape } from "../pricing/scrape";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

runPricingScrape({
  limit: arg("limit") ? parseInt(arg("limit")!, 10) : undefined,
  match: arg("match"),
  force: process.argv.includes("--force"),
}).then((r) => {
  console.log(JSON.stringify(r));
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
