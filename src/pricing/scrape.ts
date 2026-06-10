// Pricing watch — scrape runner + change detection.
//
// Picks the tools due for a re-check (older than REPLEN_PRICING_INTERVAL_HOURS,
// default 66h ≈ every ~3 days with a daily cron), hands them to the Scrapling
// scraper (scripts/pricing-scrape.py) in one batch, stores a snapshot per tool
// and diffs against the previous good snapshot. A change is only recorded when
// the diff is TRUSTWORTHY:
//   - plan-anchored amounts moved ("Pro: $25/mo → $29/mo"), or
//   - the page has a small, stable price set (≤ VOLATILE_MAX amounts on both
//     sides) and that set changed.
// Usage-based pages (EC2 et al.) produce huge amount lists and empty plan maps
// — they never fire. Silence beats a false "pricing changed".

import { spawn } from "node:child_process";
import { join } from "node:path";
import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "../db/client";

const INTERVAL_HOURS = Math.max(1, parseInt(process.env.REPLEN_PRICING_INTERVAL_HOURS ?? "66", 10) || 66);
const BATCH = Math.max(1, parseInt(process.env.REPLEN_PRICING_BATCH ?? "120", 10) || 120);
const PYTHON = process.env.REPLEN_PYTHON ?? "python3";
const SCRIPT = join(process.cwd(), "scripts", "pricing-scrape.py");
const VOLATILE_MAX = Math.max(1, parseInt(process.env.REPLEN_PRICING_VOLATILE_MAX ?? "30", 10) || 30);
const RUN_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.REPLEN_PRICING_RUN_TIMEOUT_MS ?? "6000000", 10) || 6_000_000);

type ScrapeResult =
  | { id: number; ok: true; amounts: string[]; plans: Record<string, string[]>; hash: string }
  | { id: number; ok: false; error: string };

export type PricingDiff = { summary: string; plan: string | null } | null;

// Diff two snapshots' extractions. Returns null when the difference isn't
// trustworthy enough to bother a user with. Exported for tests/CLI.
export function diffPricing(
  before: { amounts: string[]; plans: Record<string, string[]> },
  after: { amounts: string[]; plans: Record<string, string[]> },
): PricingDiff {
  // Plan-anchored diff first — the high-trust path.
  const planNames = new Set([...Object.keys(before.plans), ...Object.keys(after.plans)]);
  const changed: Array<{ plan: string; from: string[]; to: string[] }> = [];
  for (const p of planNames) {
    const a = [...(before.plans[p] ?? [])].sort();
    const b = [...(after.plans[p] ?? [])].sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push({ plan: p, from: a, to: b });
  }
  if (changed.length > 0 && changed.length <= 3) {
    const bits = changed.map((c) => {
      const cap = c.plan.charAt(0).toUpperCase() + c.plan.slice(1);
      // Show the DELTA, not the full amount lists — most plan buckets carry
      // stable secondary numbers (add-ons, overages) that didn't move.
      const added = c.to.filter((x) => !c.from.includes(x));
      const removed = c.from.filter((x) => !c.to.includes(x));
      if (removed.length === 1 && added.length === 1) return `${cap}: ${removed[0]} → ${added[0]}`;
      if (!removed.length && added.length) return `${cap}: now ${added.slice(0, 3).join(" / ")}`;
      if (!added.length && removed.length) return `${cap}: ${removed.slice(0, 3).join(" / ")} removed`;
      return `${cap}: ${removed.slice(0, 3).join("/")} → ${added.slice(0, 3).join("/")}`;
    });
    return { summary: bits.join("; ").slice(0, 200), plan: changed.length === 1 ? changed[0].plan : null };
  }
  if (changed.length > 3) {
    return { summary: `${changed.length} plan price points changed`, plan: null };
  }
  // No plan grid — only trust small, stable price sets.
  if (before.amounts.length <= VOLATILE_MAX && after.amounts.length <= VOLATILE_MAX) {
    const a = new Set(before.amounts);
    const b = new Set(after.amounts);
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) {
      const bits: string[] = [];
      if (added.length) bits.push(`new: ${added.slice(0, 4).join(", ")}`);
      if (removed.length) bits.push(`gone: ${removed.slice(0, 4).join(", ")}`);
      return { summary: `price points changed (${bits.join("; ")})`.slice(0, 200), plan: null };
    }
  }
  return null;
}

function runScraper(tools: Array<{ id: number; url: string }>): Promise<ScrapeResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pricing scraper timed out after ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`pricing scraper exited ${code}: ${err.slice(-400)}`));
      try { resolve(JSON.parse(out) as ScrapeResult[]); }
      catch { reject(new Error(`pricing scraper produced unparseable output: ${out.slice(0, 200)}`)); }
    });
    child.stdin.write(JSON.stringify(tools));
    child.stdin.end();
  });
}

const parseArr = (s: string | null): string[] => { try { const a = JSON.parse(s ?? "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
const parseMap = (s: string | null): Record<string, string[]> => { try { const o = JSON.parse(s ?? "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };

export async function runPricingScrape(opts: { limit?: number; match?: string; force?: boolean } = {}): Promise<{ scraped: number; ok: number; changes: number }> {
  const cutoff = new Date(Date.now() - INTERVAL_HOURS * 3600 * 1000);
  const dueWhere = opts.force
    ? eq(schema.pricingTools.active, true)
    : and(
        eq(schema.pricingTools.active, true),
        or(isNull(schema.pricingTools.lastScrapedAt), lt(schema.pricingTools.lastScrapedAt, cutoff)),
      );
  // Match filter applies BEFORE the batch limit, so `--match supabase` finds
  // the tool regardless of where it sits in the lastScrapedAt ordering.
  let due = await db.select().from(schema.pricingTools).where(dueWhere)
    .orderBy(asc(schema.pricingTools.lastScrapedAt));
  if (opts.match) {
    const m = opts.match.toLowerCase();
    due = due.filter((t) => t.vendor.toLowerCase().includes(m) || t.tool.toLowerCase().includes(m));
  }
  due = due.slice(0, opts.limit ?? BATCH);
  if (!due.length) return { scraped: 0, ok: 0, changes: 0 };

  console.log(`[pricing] scraping ${due.length} tools (interval ${INTERVAL_HOURS}h)`);
  const results = await runScraper(due.map((t) => ({ id: t.id, url: t.pricingUrl })));
  const byId = new Map(results.map((r) => [r.id, r]));

  let okCount = 0;
  let changeCount = 0;
  const now = new Date();
  for (const tool of due) {
    const res = byId.get(tool.id);
    if (!res) continue;
    await db.update(schema.pricingTools).set({ lastScrapedAt: now, updatedAt: now })
      .where(eq(schema.pricingTools.id, tool.id));
    if (!res.ok) {
      await db.insert(schema.pricingSnapshots).values({
        toolId: tool.id, capturedAt: now, ok: false, amounts: null, plans: null, hash: null, error: res.error,
      });
      continue;
    }
    okCount++;
    // Previous good snapshot BEFORE inserting the new one.
    const prev = await db.select().from(schema.pricingSnapshots)
      .where(and(eq(schema.pricingSnapshots.toolId, tool.id), eq(schema.pricingSnapshots.ok, true)))
      .orderBy(desc(schema.pricingSnapshots.capturedAt)).limit(1).get();
    await db.insert(schema.pricingSnapshots).values({
      toolId: tool.id, capturedAt: now, ok: true,
      amounts: JSON.stringify(res.amounts), plans: JSON.stringify(res.plans), hash: res.hash, error: null,
    });
    if (!prev || prev.hash === res.hash) continue; // baseline, or no movement
    const diff = diffPricing(
      { amounts: parseArr(prev.amounts), plans: parseMap(prev.plans) },
      { amounts: res.amounts, plans: res.plans },
    );
    if (!diff) continue; // hash moved but nothing trustworthy — volatile page noise
    await db.insert(schema.pricingChanges).values({
      toolId: tool.id, detectedAt: now, summary: diff.summary, plan: diff.plan,
      beforeJson: JSON.stringify({ amounts: parseArr(prev.amounts), plans: parseMap(prev.plans) }),
      afterJson: JSON.stringify({ amounts: res.amounts, plans: res.plans }),
    });
    changeCount++;
    console.log(`[pricing] CHANGE ${tool.vendor} / ${tool.tool}: ${diff.summary}`);
  }
  console.log(`[pricing] done: ${due.length} scraped, ${okCount} ok, ${changeCount} changes`);
  return { scraped: due.length, ok: okCount, changes: changeCount };
}
