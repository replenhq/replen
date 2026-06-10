import cron from "node-cron";
import { runPipeline } from "./run-once";
import { archiveOldHiddenForAllUsers } from "./aging";
import { runPricingScrape } from "../pricing/scrape";
import { runAnnouncementScrape } from "../announcements/scrape";
import { runEolSync } from "../announcements/deadlines";
import { processCriticalAlerts } from "../brief/alerts";
import { runWeeklyBriefs } from "../brief/weekly";

const schedule = process.env.DIGEST_CRON ?? "0 6 * * *"; // 06:00 UTC daily
// Aging policy runs once a night, 03:30 UTC - well before the morning pipeline
// so the dashboard is clean when users wake up. Soft-archives hidden matches
// older than 90 days across all users.
const agingSchedule = process.env.DIGEST_AGING_CRON ?? "30 3 * * *";
// Pricing watch: a daily batch, but each tool only re-scrapes once its
// REPLEN_PRICING_INTERVAL_HOURS (66h) has elapsed — so every tool is checked
// roughly every ~3 days, staggered, without one big thundering run.
const pricingSchedule = process.env.REPLEN_PRICING_CRON ?? "15 4 * * *";
// Announcement poller: daily batch; per-source cadence is priority-staggered
// inside the runner (P0/P1 daily, P2 every 2 days, P3 every 4).
const announceSchedule = process.env.REPLEN_ANNOUNCE_CRON ?? "0 5 * * *";
// Weekly four-questions brief: Monday 07:00 UTC, after the morning pipeline
// data has landed. Quiet weeks send nothing.
const briefSchedule = process.env.REPLEN_BRIEF_CRON ?? "0 7 * * 1";

console.log(`[cron] scheduled: pipeline=${schedule}  aging=${agingSchedule}  pricing=${pricingSchedule}  announce=${announceSchedule}  brief=${briefSchedule}`);

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

cron.schedule(pricingSchedule, async () => {
  console.log("[cron] tick - pricing watch scrape");
  try {
    await runPricingScrape();
  } catch (e) {
    console.error("[cron] pricing scrape error", e);
  }
});

cron.schedule(announceSchedule, async () => {
  console.log("[cron] tick - announcement poll");
  try {
    await runAnnouncementScrape();
  } catch (e) {
    console.error("[cron] announcement poll error", e);
  }
  // EOL sync rides the same tick — one all.json fetch + a few dozen product
  // fetches for products someone's stack actually contains.
  try {
    await runEolSync();
  } catch (e) {
    console.error("[cron] eol sync error", e);
  }
  // Critical alerts fire right after the poll that detected them — an
  // exploited CVE in a tool you use shouldn't wait for your next session.
  try {
    await processCriticalAlerts();
  } catch (e) {
    console.error("[cron] critical alerts error", e);
  }
});

cron.schedule(briefSchedule, async () => {
  console.log("[cron] tick - weekly brief");
  try {
    await runWeeklyBriefs();
  } catch (e) {
    console.error("[cron] weekly brief error", e);
  }
});

// Optional: run once on boot if RUN_ON_BOOT=1
if (process.env.RUN_ON_BOOT === "1") {
  runPipeline().catch((e) => console.error("[boot] pipeline error", e));
}

// keep process alive
setInterval(() => {}, 1 << 30);
