// One-shot announcement poll, outside the cron. For testing and manual kicks.
//
// Usage:
//   tsx src/cli/announce-scrape-once.ts                 # the due batch
//   tsx src/cli/announce-scrape-once.ts --match stripe  # one vendor/product
//   tsx src/cli/announce-scrape-once.ts --limit 10 --force

import { runAnnouncementScrape } from "../announcements/scrape";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

runAnnouncementScrape({
  limit: arg("limit") ? parseInt(arg("limit")!, 10) : undefined,
  match: arg("match"),
  force: process.argv.includes("--force"),
}).then((r) => {
  console.log(JSON.stringify(r));
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
