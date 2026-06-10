// One-shot weekly brief, outside the cron. For testing and manual sends.
//
// Usage:
//   tsx src/cli/brief-once.ts --dry            # print, don't send
//   tsx src/cli/brief-once.ts --user 1         # only this user
//   tsx src/cli/brief-once.ts --user 1 --dry

import { runWeeklyBriefs } from "../brief/weekly";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

runWeeklyBriefs({
  dry: process.argv.includes("--dry"),
  onlyUserId: arg("user") ? parseInt(arg("user")!, 10) : undefined,
}).then((r) => {
  console.log(JSON.stringify(r));
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
