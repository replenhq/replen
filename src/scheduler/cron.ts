import cron from "node-cron";
import { runPipeline } from "./run-once";
import { archiveOldHiddenForAllUsers } from "./aging";

const schedule = process.env.DIGEST_CRON ?? "0 6 * * *"; // 06:00 UTC daily
// Aging policy runs once a night, 03:30 UTC - well before the morning pipeline
// so the dashboard is clean when users wake up. Soft-archives hidden matches
// older than 90 days across all users.
const agingSchedule = process.env.DIGEST_AGING_CRON ?? "30 3 * * *";

console.log(`[cron] scheduled: pipeline=${schedule}  aging=${agingSchedule}`);

cron.schedule(schedule, async () => {
  console.log("[cron] tick - running pipeline");
  try {
    await runPipeline();
  } catch (e) {
    console.error("[cron] pipeline error", e);
  }
});

cron.schedule(agingSchedule, async () => {
  console.log("[cron] tick - archive aging hidden matches");
  try {
    const result = await archiveOldHiddenForAllUsers(90);
    console.log(`[cron] aging done: ${result.archived} archived across ${result.users} users`);
  } catch (e) {
    console.error("[cron] aging error", e);
  }
});

// Optional: run once on boot if RUN_ON_BOOT=1
if (process.env.RUN_ON_BOOT === "1") {
  runPipeline().catch((e) => console.error("[boot] pipeline error", e));
}

// keep process alive
setInterval(() => {}, 1 << 30);
