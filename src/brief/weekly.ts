// The weekly four-questions brief — the anchor of the always-on layer.
//
// One email per user per ISO week, answering the only four questions that
// matter, FOR THEIR STACK: will anything break · is there a security issue ·
// will my bill increase · do I need to upgrade something. Items come from the
// week's classified events, pricing changes, and upcoming deadlines, all
// matched through the same deps+tags token contract as the footnote.
//
// Calm rules carry over from the in-session surface: every item passed the
// four-questions gate, each item appears in exactly ONE section (most urgent
// wins), and A QUIET WEEK SENDS NOTHING — no "nothing happened!" filler mail.

import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client";
import { pickEmailProvider } from "../email/providers";
import { escapeHtml, escapeHref } from "../email/escape";
import { userToolTokens } from "../lib/detect-tokens";
import { parseTechSummaryDeps } from "../fetchers/stack-watch/registry";
import { SEVERITY_ORDER, type Severity } from "../announcements/classify";

const LOOKBACK_DAYS = Math.max(1, parseInt(process.env.REPLEN_BRIEF_LOOKBACK_DAYS ?? "7", 10) || 7);
const DEADLINE_AHEAD_DAYS = Math.max(7, parseInt(process.env.REPLEN_BRIEF_DEADLINE_DAYS ?? "30", 10) || 30);
const MAX_PER_SECTION = Math.max(1, parseInt(process.env.REPLEN_BRIEF_MAX_PER_SECTION ?? "5", 10) || 5);

type BriefItem = { line: string; url: string | null };
type Brief = {
  security: BriefItem[];
  breaking: BriefItem[];
  bill: BriefItem[];
  upgrade: BriefItem[];
  total: number;
};

const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function isoWeekKey(d: Date): string {
  // ISO-8601 week number, UTC.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400e3 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function userTokensFor(userId: number): Promise<Set<string>> {
  const projects = await db.select({ techSummary: schema.projectProfiles.techSummary, tags: schema.projectProfiles.tags })
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      eq(schema.projectProfiles.included, true),
    ));
  const deps = new Set<string>();
  const tags = new Set<string>();
  for (const p of projects) {
    for (const d of parseTechSummaryDeps(p.techSummary)) deps.add(d);
    try { for (const t of JSON.parse(p.tags ?? "[]")) if (typeof t === "string") tags.add(t); } catch { /* */ }
  }
  return userToolTokens(deps, tags);
}

const tokensMatch = (detectTokens: string | null, userTokens: Set<string>): boolean => {
  try {
    const toks: string[] = JSON.parse(detectTokens ?? "[]");
    return toks.some((t) => userTokens.has(t));
  } catch {
    return false;
  }
};

// Build the brief content for one user. Exported for the --dry CLI path.
export async function buildBrief(userId: number, now: Date = new Date()): Promise<Brief> {
  const userTokens = await userTokensFor(userId);
  const brief: Brief = { security: [], breaking: [], bill: [], upgrade: [], total: 0 };
  if (userTokens.size === 0) return brief;
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400e3);

  // Classified events of the week — each lands in ONE section (most urgent).
  const events = await db
    .select({
      severity: schema.classifiedEvents.severity,
      title: schema.classifiedEvents.title,
      url: schema.classifiedEvents.url,
      willBreakApp: schema.classifiedEvents.willBreakApp,
      securityIssue: schema.classifiedEvents.securityIssue,
      billIncrease: schema.classifiedEvents.billIncrease,
      upgradeNeeded: schema.classifiedEvents.upgradeNeeded,
      vendor: schema.announcementSources.vendor,
      product: schema.announcementSources.product,
      detectTokens: schema.announcementSources.detectTokens,
    })
    .from(schema.classifiedEvents)
    .innerJoin(schema.announcementSources, eq(schema.classifiedEvents.sourcePk, schema.announcementSources.id))
    .where(gte(schema.classifiedEvents.detectedAt, since));
  const matchedEvents = events
    .filter((e) => tokensMatch(e.detectTokens, userTokens))
    .filter((e) => e.willBreakApp || e.securityIssue || e.billIncrease || e.upgradeNeeded)
    .sort((a, b) => (SEVERITY_ORDER[b.severity as Severity] ?? 0) - (SEVERITY_ORDER[a.severity as Severity] ?? 0));
  for (const e of matchedEvents) {
    const name = e.product === e.vendor ? e.vendor : `${e.vendor} ${e.product}`;
    const item = { line: `${name}: ${e.title}`, url: e.url };
    if (e.securityIssue) brief.security.push(item);
    else if (e.willBreakApp) brief.breaking.push(item);
    else if (e.billIncrease) brief.bill.push(item);
    else brief.upgrade.push(item);
  }

  // Pricing changes of the week.
  const priceChanges = await db
    .select({
      summary: schema.pricingChanges.summary,
      vendor: schema.pricingTools.vendor,
      tool: schema.pricingTools.tool,
      url: schema.pricingTools.pricingUrl,
      detectTokens: schema.pricingTools.detectTokens,
    })
    .from(schema.pricingChanges)
    .innerJoin(schema.pricingTools, eq(schema.pricingChanges.toolId, schema.pricingTools.id))
    .where(gte(schema.pricingChanges.detectedAt, since));
  for (const c of priceChanges) {
    if (!tokensMatch(c.detectTokens, userTokens)) continue;
    const name = c.tool === c.vendor ? c.vendor : `${c.vendor} ${c.tool}`;
    brief.bill.push({ line: `${name}: ${c.summary}`, url: c.url });
  }

  // Deadlines inside the horizon (incl. just-passed within the grace window).
  const deadlines = await db.select().from(schema.deadlineEvents)
    .where(gte(schema.deadlineEvents.deadline, new Date(now.getTime() - 14 * 86400e3)));
  for (const d of deadlines) {
    if (d.deadline.getTime() > now.getTime() + DEADLINE_AHEAD_DAYS * 86400e3) continue;
    if (!tokensMatch(d.detectTokens, userTokens)) continue;
    const days = Math.round((d.deadline.getTime() - now.getTime()) / 86400e3);
    const what = d.kind === "eol" ? `${d.title} end-of-life` : `${d.product}: ${d.title}`;
    const whenStr = days < 0 ? `passed ${fmtDate(d.deadline)}` : days === 0 ? "TODAY" : `${fmtDate(d.deadline)} (${days}d)`;
    brief.upgrade.push({ line: `${what} — ${whenStr}`, url: d.url });
  }

  for (const k of ["security", "breaking", "bill", "upgrade"] as const) brief[k].splice(MAX_PER_SECTION);
  brief.total = brief.security.length + brief.breaking.length + brief.bill.length + brief.upgrade.length;
  return brief;
}

const SECTIONS: Array<{ key: keyof Omit<Brief, "total">; q: string }> = [
  { key: "security", q: "Is there a security issue?" },
  { key: "breaking", q: "Will anything break?" },
  { key: "bill", q: "Will my bill increase?" },
  { key: "upgrade", q: "Do I need to upgrade something?" },
];

export function renderBriefText(brief: Brief, weekKey: string): string {
  const lines = [`Replen weekly brief (${weekKey}) — ${brief.total} thing${brief.total === 1 ? "" : "s"} moved in your stack`, ""];
  for (const s of SECTIONS) {
    if (!brief[s.key].length) continue;
    lines.push(s.q);
    for (const it of brief[s.key]) lines.push(`  - ${it.line}${it.url ? `\n    ${it.url}` : ""}`);
    lines.push("");
  }
  lines.push("Everything above passed the gate: a tool your stack actually uses, answering at least one of the four questions.");
  return lines.join("\n");
}

export function renderBriefHtml(brief: Brief, weekKey: string): string {
  const parts = [
    `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">`,
    `<h2 style="font-weight:600">This week in your stack</h2>`,
    `<p style="color:#666">${brief.total} item${brief.total === 1 ? "" : "s"} · ${escapeHtml(weekKey)} · only tools you use, only the four questions</p>`,
  ];
  for (const s of SECTIONS) {
    if (!brief[s.key].length) continue;
    parts.push(`<h3 style="margin-bottom:4px">${escapeHtml(s.q)}</h3><ul style="margin-top:4px">`);
    for (const it of brief[s.key]) {
      const body = escapeHtml(it.line);
      parts.push(`<li style="margin:4px 0">${it.url ? `<a href="${escapeHref(it.url)}" style="color:#1a1a1a">${body}</a>` : body}</li>`);
    }
    parts.push(`</ul>`);
  }
  parts.push(`<p style="color:#999;font-size:12px;margin-top:24px">Replen sends this only when something qualified — a quiet week sends nothing.</p></div>`);
  return parts.join("\n");
}

export async function runWeeklyBriefs(opts: { dry?: boolean; onlyUserId?: number } = {}): Promise<{ considered: number; sent: number; quiet: number }> {
  const now = new Date();
  const weekKey = isoWeekKey(now);
  const fromAddr = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME ?? "Replen";
  const provider = opts.dry ? null : pickEmailProvider();

  const rows = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      emailToAddress: schema.userSettings.emailToAddress,
      weeklyBriefEnabled: schema.userSettings.weeklyBriefEnabled,
      enabled: schema.userSettings.enabled,
    })
    .from(schema.users)
    .innerJoin(schema.userSettings, eq(schema.userSettings.userId, schema.users.id));

  let considered = 0;
  let sent = 0;
  let quiet = 0;
  for (const u of rows) {
    if (opts.onlyUserId != null && u.userId !== opts.onlyUserId) continue;
    if (!u.enabled || !u.weeklyBriefEnabled) continue;
    const to = u.emailToAddress ?? u.email;
    if (!to) continue;
    considered++;

    const already = await db.select({ id: schema.briefLog.id }).from(schema.briefLog)
      .where(and(eq(schema.briefLog.userId, u.userId), eq(schema.briefLog.weekKey, weekKey))).get();
    if (already && !opts.dry) continue;

    const brief = await buildBrief(u.userId, now);
    if (brief.total === 0) { quiet++; continue; } // silence beats filler

    const subject = `This week in your stack: ${brief.total} thing${brief.total === 1 ? "" : "s"} worth knowing`;
    if (opts.dry) {
      console.log(`--- user=${u.userId} → ${to} · ${subject}\n${renderBriefText(brief, weekKey)}`);
      sent++;
      continue;
    }
    if (!provider || !fromAddr) {
      console.warn("[brief] no email provider / EMAIL_FROM_ADDRESS configured; skipping sends");
      return { considered, sent, quiet };
    }
    const res = await provider.send({
      from: `${fromName} <${fromAddr}>`,
      to,
      subject,
      html: renderBriefHtml(brief, weekKey),
      text: renderBriefText(brief, weekKey),
    });
    if (res.ok) {
      sent++;
      await db.insert(schema.briefLog).values({ userId: u.userId, weekKey, sentAt: now }).onConflictDoNothing();
      console.log(`[brief] sent week ${weekKey} to user=${u.userId} (${brief.total} items)`);
    } else {
      console.warn(`[brief] user=${u.userId} send failed: ${res.error}`);
    }
  }
  console.log(`[brief] done: ${considered} considered, ${sent} sent, ${quiet} quiet`);
  return { considered, sent, quiet };
}
