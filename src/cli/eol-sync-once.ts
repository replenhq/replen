// One-shot endoflife.date sync, outside the cron. For testing and manual kicks.
//
// Usage:
//   tsx src/cli/eol-sync-once.ts

import { runEolSync } from "../announcements/deadlines";

runEolSync().then((r) => {
  console.log(JSON.stringify(r));
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
