// Phase 3 — dated obligations. "Support ends Apr 30" is the highest-value
// announcement shape Replen can track: it has a deadline, the user either is
// or isn't affected, and the cost of missing it is concrete. Two feeds:
//
//   1. endoflife.date — structured EOL cycles for ~380 runtimes/databases/
//      frameworks (free JSON, no key). Products are matched against the union
//      of every user's deps+tags, so we only fetch cycles anyone could care
//      about. Deterministic, no scraping, no LLM.
//   2. Date extraction from deprecation/breaking-change announcements that
//      the phase-2 poller classifies (extractDeadline below, hooked into
//      scrape.ts).
//
// Surfacing is staged per (user, deadline): one ANNOUNCE when first seen,
// one T-30 reminder, one T-7 reminder — never more. The server can't know
// which VERSION a user pins (deps carry names, not versions), so the line
// says "worth checking" and the in-session agent — which has the lockfile
// open — verifies actual affectedness when the user engages.

import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client";

const EOL_HORIZON_DAYS = Math.max(7, parseInt(process.env.REPLEN_EOL_HORIZON_DAYS ?? "180", 10) || 180);
const EOL_GRACE_DAYS = Math.max(0, parseInt(process.env.REPLEN_EOL_GRACE_DAYS ?? "30", 10) || 30);
const ANNOUNCE_FRESH_DAYS = Math.max(1, parseInt(process.env.REPLEN_DEADLINE_FRESH_DAYS ?? "14", 10) || 14);

// ── date extraction (for announcement-derived deadlines) ───────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const ISO_RE = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
const MDY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/gi;
const DMY_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/gi;

// Earliest FUTURE date (≤ 2 years out) mentioned in the text, or null. Past
// dates are publication dates, not deadlines — ignored.
export function extractDeadline(text: string, now: Date = new Date()): Date | null {
  const candidates: number[] = [];
  const push = (y: number, m: number, d: number) => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return;
    const t = Date.UTC(y, m, d);
    if (t > now.getTime() && t < now.getTime() + 730 * 86400e3) candidates.push(t);
  };
  for (const m of text.matchAll(ISO_RE)) push(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  for (const m of text.matchAll(MDY_RE)) push(parseInt(m[3], 10), MONTHS[m[1].toLowerCase()], parseInt(m[2], 10));
  for (const m of text.matchAll(DMY_RE)) push(parseInt(m[3], 10), MONTHS[m[2].toLowerCase()], parseInt(m[1], 10));
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates));
}

// ── endoflife.date sync ─────────────────────────────────────────────────────

// Tokens a product slug can be recognised by in deps/tags. Deliberately NOT
// run through the vendor GENERIC blocklist: for EOL the product IS the
// identity ("python" should match python users).
function slugTokens(slug: string): string[] {
  const out = new Set<string>([slug]);
  out.add(slug.replace(/-/g, " "));
  out.add(slug.replace(/-/g, ""));
  if (slug.endsWith("js") && slug.length > 4) out.add(slug.slice(0, -2)); // nextjs → next, nodejs → node
  return [...out].filter((t) => t.length >= 3);
}

type EolCycle = { cycle: string; eol: string | boolean | null };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "replen/deadline-watch" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

// Union of every active user's deps + tags — which products anyone could care
// about. Internal only; nothing is sent anywhere (endoflife.date is fetched
// per-product, the same set for everyone).
async function platformTokenUnion(): Promise<Set<string>> {
  const { parseTechSummaryDeps } = await import("../fetchers/stack-watch/registry");
  const { userToolTokens } = await import("../lib/detect-tokens");
  const rows = await db.select({ techSummary: schema.projectProfiles.techSummary, tags: schema.projectProfiles.tags })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.active, true), eq(schema.projectProfiles.included, true)));
  const deps = new Set<string>();
  const tags = new Set<string>();
  for (const r of rows) {
    for (const d of parseTechSummaryDeps(r.techSummary)) deps.add(d);
    try { for (const t of JSON.parse(r.tags ?? "[]")) if (typeof t === "string") tags.add(t); } catch { /* */ }
  }
  return userToolTokens(deps, tags);
}

export async function runEolSync(): Promise<{ products: number; deadlines: number }> {
  const tokens = await platformTokenUnion();
  if (tokens.size === 0) return { products: 0, deadlines: 0 };
  const slugs = await fetchJson<string[]>("https://endoflife.date/api/all.json");
  const matched = slugs.filter((s) => slugTokens(s).some((t) => tokens.has(t)));
  console.log(`[deadlines] endoflife.date: ${matched.length}/${slugs.length} products match someone's stack`);

  const now = new Date();
  const lo = now.getTime() - EOL_GRACE_DAYS * 86400e3;
  const hi = now.getTime() + EOL_HORIZON_DAYS * 86400e3;
  let created = 0;
  for (const slug of matched) {
    let cycles: EolCycle[];
    try {
      cycles = await fetchJson<EolCycle[]>(`https://endoflife.date/api/${slug}.json`);
    } catch (e) {
      console.warn(`[deadlines] ${slug}: ${(e as Error).message}`);
      continue;
    }
    for (const c of cycles) {
      if (typeof c.eol !== "string") continue; // false/true = no date
      const t = Date.parse(c.eol);
      if (!Number.isFinite(t) || t < lo || t > hi) continue;
      const dedupeKey = `eol:${slug}:${c.cycle}:${c.eol}`;
      const inserted = await db.insert(schema.deadlineEvents).values({
        dedupeKey,
        kind: "eol",
        product: slug,
        cycle: String(c.cycle),
        title: `${slug} ${c.cycle}`,
        url: `https://endoflife.date/${slug}`,
        deadline: new Date(t),
        detectTokens: JSON.stringify(slugTokens(slug)),
        sourcePk: null,
        detectedAt: now,
      }).onConflictDoNothing().returning({ id: schema.deadlineEvents.id });
      if (inserted.length) {
        created++;
        console.log(`[deadlines] EOL ${slug} ${c.cycle} → ${c.eol}`);
      }
    }
  }
  console.log(`[deadlines] sync done: ${created} new deadline(s)`);
  return { products: matched.length, deadlines: created };
}

// Record an announcement-derived deadline (called from the phase-2 poller for
// deprecation / breaking_change events whose text carries a future date).
export async function recordAnnouncementDeadline(args: {
  sourcePk: number; product: string; title: string; url: string | null;
  deadline: Date; detectTokens: string | null; rawHash: string;
}): Promise<void> {
  await db.insert(schema.deadlineEvents).values({
    dedupeKey: `ann:${args.sourcePk}:${args.rawHash}`,
    kind: "deprecation",
    product: args.product,
    cycle: null,
    title: args.title.slice(0, 200),
    url: args.url,
    deadline: args.deadline,
    detectTokens: args.detectTokens,
    sourcePk: args.sourcePk,
    detectedAt: new Date(),
  }).onConflictDoNothing();
}

// ── surfacing ───────────────────────────────────────────────────────────────

export type DeadlinePs = { deadlineId: number; phase: "announce" | "t30" | "t7"; line: string; urgent: boolean };

const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

// dep/runtime name → projects that reported a pinned version for it.
export type VersionEntry = { slug: string; version: string };
export async function loadUserVersions(userId: number): Promise<Map<string, VersionEntry[]>> {
  const rows = await db.select({ slug: schema.projectProfiles.slug, depVersions: schema.projectProfiles.depVersions })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.active, true), eq(schema.projectProfiles.included, true)));
  const map = new Map<string, VersionEntry[]>();
  for (const r of rows) {
    if (!r.depVersions) continue;
    try {
      const obj = JSON.parse(r.depVersions) as Record<string, string>;
      for (const [name, version] of Object.entries(obj)) {
        if (typeof version !== "string") continue;
        const arr = map.get(name) ?? [];
        arr.push({ slug: r.slug, version });
        map.set(name, arr);
      }
    } catch { /* malformed — skip project */ }
  }
  return map;
}

// "18.19.0" matches cycle "18"; "3.10.12" matches "3.10".
export function versionMatchesCycle(version: string, cycle: string): boolean {
  const v = version.replace(/^v/i, "");
  return v === cycle || v.startsWith(`${cycle}.`);
}

export async function deadlinePs(userId: number, userTokens: Set<string>): Promise<DeadlinePs | null> {
  if (userTokens.size === 0) return null;
  const now = Date.now();
  const events = await db.select().from(schema.deadlineEvents)
    .where(gte(schema.deadlineEvents.deadline, new Date(now - EOL_GRACE_DAYS * 86400e3)));
  if (!events.length) return null;
  const surfaced = await db.select({ deadlineId: schema.deadlineSurfaces.deadlineId, phase: schema.deadlineSurfaces.phase })
    .from(schema.deadlineSurfaces).where(eq(schema.deadlineSurfaces.userId, userId));
  const done = new Set(surfaced.map((s) => `${s.deadlineId}:${s.phase}`));
  const versions = await loadUserVersions(userId);

  type Candidate = { e: typeof events[number]; phase: "announce" | "t30" | "t7"; rank: number; affected: VersionEntry[] };
  const candidates: Candidate[] = [];
  for (const e of events) {
    let toks: string[] = [];
    try { toks = JSON.parse(e.detectTokens ?? "[]"); } catch { /* */ }
    if (!toks.some((t) => userTokens.has(t))) continue;
    // Version awareness — precision in BOTH directions. When any project
    // reported a pinned version for this product:
    //   - EOL with a cycle: only the projects ON that cycle are affected;
    //     if none are, the deadline is suppressed entirely for this user.
    //   - deprecations (no cycle): name-level attribution ("in acme, drone").
    // No version data → the generic "worth checking your pins" wording.
    const reported = toks.flatMap((t) => versions.get(t) ?? []);
    let affected: VersionEntry[] = [];
    if (reported.length > 0) {
      affected = e.kind === "eol" && e.cycle
        ? reported.filter((v) => versionMatchesCycle(v.version, e.cycle!))
        : reported;
      if (affected.length === 0 && e.kind === "eol" && e.cycle) continue; // verified unaffected
    }
    const days = Math.round((e.deadline.getTime() - now) / 86400e3);
    // The phase is a function of time-to-deadline ONLY — once the current
    // phase has been shown, the deadline stays quiet until the next phase
    // window opens (no falling back to an earlier, staler phase).
    const phase: Candidate["phase"] = days <= 7 ? "t7" : days <= 30 ? "t30" : "announce";
    if (done.has(`${e.id}:${phase}`)) continue;
    if (phase === "announce" && e.detectedAt.getTime() <= now - ANNOUNCE_FRESH_DAYS * 86400e3) continue;
    candidates.push({ e, phase, rank: phase === "t7" ? 3 : phase === "t30" ? 2 : 1, affected });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rank - a.rank || a.e.deadline.getTime() - b.e.deadline.getTime());

  const { e, phase, affected } = candidates[0];
  const days = Math.round((e.deadline.getTime() - now) / 86400e3);
  const when = fmtDate(e.deadline);
  const what = e.kind === "eol" ? `${e.title} reaches end-of-life` : `${e.product}'s deadline ("${e.title}")`;
  // With version reports the line names the affected repos; without, it hedges.
  const affectedStr = affected.length
    ? `affects ${affected.slice(0, 3).map((a) => `\`${a.slug}\` (${a.version})`).join(", ")}${affected.length > 3 ? ` +${affected.length - 3} more` : ""}`
    : null;
  let line: string;
  if (phase === "t7" && days < 0) {
    const head = e.kind === "eol"
      ? `${e.title} reached end-of-life on ${when}`
      : `${e.product}'s deadline ("${e.title}") passed on ${when}`;
    line = affectedStr
      ? `${head} — ${affectedStr}; that's now unsupported.`
      : `${head} — if anything still ${e.kind === "eol" ? "pins it" : "relies on it"}, that's now unsupported.`;
  } else if (phase === "t7") {
    line = `${what} ${days === 0 ? "is TODAY" : `is this week (${when})`} — ${affectedStr ?? "worth checking your pins now"}.`;
  } else if (phase === "t30") {
    line = `reminder: ${what} on ${when} (${days} days) — ${affectedStr ?? "you use this; worth planning the bump"}.`;
  } else {
    line = `${what} on ${when} — ${affectedStr ?? "you use this; worth checking whether any project still pins it"}.`;
  }
  return { deadlineId: e.id, phase, line, urgent: phase === "t7" };
}
