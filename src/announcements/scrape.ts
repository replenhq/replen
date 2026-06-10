// Announcement poller — phase 2 of the announcement layer.
//
// Polls the HTML/feed announcement sources (changelogs, security pages,
// rss+web, plain web) on a priority-staggered cadence, turns NEW content into
// raw_announcements, and runs the deterministic keyword classifier over each
// new item. Only classified events (event type + severity + impact answers)
// ever reach a user, and only via the footnote surfacing in
// src/announcements/surface.ts.
//
// First contact with a source is a BASELINE: feed items / page text are
// recorded without creating events, so seeding 230 sources doesn't flood
// day-one users with months of old news. Diffs after that are real news.
//
// github_releases is handled by stack-watch, pricing_page by the pricing
// watch, github_advisories by the security lens (the aggregators cover them),
// status_page deliberately unpolled (real-time ops is not Replen's job).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { classifyAnnouncement } from "./classify";

const POLLED_TYPES = ["changelog", "security_page", "rss+web", "web"];
const BASE_INTERVAL_HOURS = Math.max(1, parseInt(process.env.REPLEN_ANNOUNCE_INTERVAL_HOURS ?? "24", 10) || 24);
const BATCH = Math.max(1, parseInt(process.env.REPLEN_ANNOUNCE_BATCH ?? "150", 10) || 150);
const PYTHON = process.env.REPLEN_PYTHON ?? "python3";
const SCRIPT = join(process.cwd(), "scripts", "announcements-scrape.py");
const RUN_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.REPLEN_ANNOUNCE_RUN_TIMEOUT_MS ?? "6000000", 10) || 6_000_000);
// New-event caps: a source that suddenly "publishes" 30 classified items is
// far more likely a parser hiccup than 30 real incidents.
const MAX_EVENTS_PER_SOURCE = Math.max(1, parseInt(process.env.REPLEN_ANNOUNCE_MAX_EVENTS ?? "3", 10) || 3);
const RECENT_DAYS = Math.max(1, parseInt(process.env.REPLEN_ANNOUNCE_RECENT_DAYS ?? "30", 10) || 30);
// Auto-retire after this many consecutive failures (dead URL → needs_review).
const MAX_FAILURES = Math.max(2, parseInt(process.env.REPLEN_ANNOUNCE_MAX_FAILURES ?? "8", 10) || 8);

// Priority-staggered cadence: P0/P1 every base interval, P2 ×2, P3 ×4.
const PRIORITY_MULT: Record<string, number> = { P0: 1, P1: 1, P2: 2, P3: 4 };

type FeedItem = { title: string; url: string; publishedAt: string; summary: string };
type ScrapeResult =
  | { id: number; ok: true; kind: "feed"; items: FeedItem[] }
  | { id: number; ok: true; kind: "page"; text: string; hash: string }
  | { id: number; ok: false; error: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// Page lines worth diffing: long enough to be prose/changelog entries, not nav.
function pageLines(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length >= 24) out.add(line);
  }
  return out;
}

function runScraper(sources: Array<{ id: number; url: string }>): Promise<ScrapeResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`announcement scraper timed out after ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`announcement scraper exited ${code}: ${err.slice(-400)}`));
      try { resolve(JSON.parse(out) as ScrapeResult[]); }
      catch { reject(new Error(`announcement scraper produced unparseable output: ${out.slice(0, 200)}`)); }
    });
    child.stdin.write(JSON.stringify(sources));
    child.stdin.end();
  });
}

export async function runAnnouncementScrape(opts: { limit?: number; match?: string; force?: boolean } = {}): Promise<{ scraped: number; ok: number; raws: number; events: number }> {
  const now = new Date();
  let candidates = await db.select().from(schema.announcementSources)
    .where(and(
      inArray(schema.announcementSources.sourceType, POLLED_TYPES),
      eq(schema.announcementSources.active, true),
    ))
    .orderBy(asc(schema.announcementSources.lastCheckedAt));
  if (!opts.force) {
    candidates = candidates.filter((s) => {
      if (!s.lastCheckedAt) return true;
      const mult = PRIORITY_MULT[s.priority] ?? 2;
      return s.lastCheckedAt.getTime() < now.getTime() - BASE_INTERVAL_HOURS * mult * 3600 * 1000;
    });
  }
  if (opts.match) {
    const m = opts.match.toLowerCase();
    candidates = candidates.filter((s) => s.vendor.toLowerCase().includes(m) || s.product.toLowerCase().includes(m));
  }
  const due = candidates.slice(0, opts.limit ?? BATCH);
  if (!due.length) return { scraped: 0, ok: 0, raws: 0, events: 0 };

  console.log(`[announce] polling ${due.length} sources (base interval ${BASE_INTERVAL_HOURS}h)`);
  const results = await runScraper(due.map((s) => ({ id: s.id, url: s.sourceUrl })));
  const byId = new Map(results.map((r) => [r.id, r]));

  let okCount = 0;
  let rawCount = 0;
  let eventCount = 0;
  for (const src of due) {
    const res = byId.get(src.id);
    if (!res) continue;

    if (!res.ok) {
      const failures = src.consecutiveFailures + 1;
      const retire = failures >= MAX_FAILURES;
      await db.update(schema.announcementSources).set({
        lastCheckedAt: now,
        lastCheckStatus: res.error.slice(0, 200),
        consecutiveFailures: failures,
        ...(retire ? { active: false, seedStatus: "needs_review" } : {}),
        updatedAt: now,
      }).where(eq(schema.announcementSources.id, src.id));
      if (retire) console.warn(`[announce] retired ${src.vendor} / ${src.product} after ${failures} failures (${res.error.slice(0, 80)})`);
      continue;
    }
    okCount++;
    await db.update(schema.announcementSources).set({
      lastCheckedAt: now, lastCheckStatus: "ok", consecutiveFailures: 0, updatedAt: now,
    }).where(eq(schema.announcementSources.id, src.id));

    let eventTypes: string[] = [];
    try { eventTypes = JSON.parse(src.eventTypes ?? "[]"); } catch { /* */ }

    if (res.kind === "feed") {
      const existing = await db.select({ id: schema.rawAnnouncements.id }).from(schema.rawAnnouncements)
        .where(eq(schema.rawAnnouncements.sourcePk, src.id)).limit(1);
      const baseline = existing.length === 0;
      let newEvents = 0;
      for (const item of res.items) {
        const rawHash = sha(`${item.title}|${item.url}`);
        const dup = await db.select({ id: schema.rawAnnouncements.id }).from(schema.rawAnnouncements)
          .where(and(eq(schema.rawAnnouncements.sourcePk, src.id), eq(schema.rawAnnouncements.rawHash, rawHash))).get();
        if (dup) continue;
        const pubMs = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
        const publishedAt = Number.isFinite(pubMs) ? new Date(pubMs) : null;
        const inserted = await db.insert(schema.rawAnnouncements).values({
          sourcePk: src.id,
          canonicalUrl: item.url || src.sourceUrl,
          title: item.title.slice(0, 200),
          summary: item.summary || null,
          publishedAt,
          fetchedAt: now,
          rawHash,
        }).returning({ id: schema.rawAnnouncements.id }).get();
        rawCount++;
        if (baseline || newEvents >= MAX_EVENTS_PER_SOURCE) continue;
        const tooOld = publishedAt != null && publishedAt.getTime() < now.getTime() - RECENT_DAYS * 86400e3;
        if (tooOld) continue;
        const cls = classifyAnnouncement(`${item.title} ${item.summary}`, eventTypes);
        if (!cls) continue;
        await db.insert(schema.classifiedEvents).values({
          rawId: inserted?.id ?? null,
          sourcePk: src.id,
          eventType: cls.eventType,
          severity: cls.severity,
          title: item.title.slice(0, 200),
          summary: item.summary?.slice(0, 600) || null,
          url: item.url || src.sourceUrl,
          willBreakApp: cls.impacts.willBreakApp,
          securityIssue: cls.impacts.securityIssue,
          billIncrease: cls.impacts.billIncrease,
          upgradeNeeded: cls.impacts.upgradeNeeded,
          detectedAt: now,
        });
        newEvents++;
        eventCount++;
        console.log(`[announce] EVENT ${src.vendor} / ${src.product} [${cls.eventType}/${cls.severity}]: ${item.title.slice(0, 90)}`);
      }
    } else {
      // HTML page — line-set diff against the cached previous fetch.
      const prev = await db.select().from(schema.announcementPageCache)
        .where(eq(schema.announcementPageCache.sourcePk, src.id)).get();
      if (!prev) {
        await db.insert(schema.announcementPageCache).values({ sourcePk: src.id, text: res.text, hash: res.hash, fetchedAt: now });
        continue; // baseline
      }
      if (prev.hash === res.hash) continue;
      const oldLines = pageLines(prev.text);
      const fresh = [...pageLines(res.text)].filter((l) => !oldLines.has(l));
      await db.update(schema.announcementPageCache).set({ text: res.text, hash: res.hash, fetchedAt: now })
        .where(eq(schema.announcementPageCache.sourcePk, src.id));
      if (!fresh.length) continue;
      const matched = fresh.filter((l) => classifyAnnouncement(l, eventTypes) !== null).slice(0, 12);
      if (!matched.length) continue;
      const joined = matched.join(" • ");
      const cls = classifyAnnouncement(joined, eventTypes);
      if (!cls) continue;
      const rawHash = sha(joined);
      const dup = await db.select({ id: schema.rawAnnouncements.id }).from(schema.rawAnnouncements)
        .where(and(eq(schema.rawAnnouncements.sourcePk, src.id), eq(schema.rawAnnouncements.rawHash, rawHash))).get();
      if (dup) continue;
      const inserted = await db.insert(schema.rawAnnouncements).values({
        sourcePk: src.id,
        canonicalUrl: src.sourceUrl,
        title: matched[0].slice(0, 200),
        summary: joined.slice(0, 1000),
        publishedAt: null,
        fetchedAt: now,
        rawHash,
      }).returning({ id: schema.rawAnnouncements.id }).get();
      rawCount++;
      await db.insert(schema.classifiedEvents).values({
        rawId: inserted?.id ?? null,
        sourcePk: src.id,
        eventType: cls.eventType,
        severity: cls.severity,
        title: matched[0].slice(0, 200),
        summary: joined.slice(0, 600),
        url: src.sourceUrl,
        willBreakApp: cls.impacts.willBreakApp,
        securityIssue: cls.impacts.securityIssue,
        billIncrease: cls.impacts.billIncrease,
        upgradeNeeded: cls.impacts.upgradeNeeded,
        detectedAt: now,
      });
      eventCount++;
      console.log(`[announce] EVENT ${src.vendor} / ${src.product} [${cls.eventType}/${cls.severity}]: ${matched[0].slice(0, 90)}`);
    }
  }
  console.log(`[announce] done: ${due.length} polled, ${okCount} ok, ${rawCount} new items, ${eventCount} classified events`);
  return { scraped: due.length, ok: okCount, raws: rawCount, events: eventCount };
}
