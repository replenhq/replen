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

import { and, eq, gte, like } from "drizzle-orm";
import { db, schema } from "../db/client";
import { pickEmailProvider } from "../email/providers";
import { brandedEmail, listUnsubHeaders, C } from "../email/layout";
import { unsubscribeUrl, prefsUrl, dashboardUrl } from "../lib/unsub-sign";
import { escapeHtml, escapeHref } from "../email/escape";
import { userToolTokens } from "../lib/detect-tokens";
import { parseTechSummaryDeps } from "../fetchers/stack-watch/registry";
import { SEVERITY_ORDER, type Severity } from "../announcements/classify";
import { loadUserVersions, versionMatchesCycle } from "../announcements/deadlines";
import { queueAddUrl } from "../lib/queue-sign";

const LOOKBACK_DAYS = Math.max(1, parseInt(process.env.REPLEN_BRIEF_LOOKBACK_DAYS ?? "7", 10) || 7);
const DEADLINE_AHEAD_DAYS = Math.max(7, parseInt(process.env.REPLEN_BRIEF_DEADLINE_DAYS ?? "30", 10) || 30);
const MAX_PER_SECTION = Math.max(1, parseInt(process.env.REPLEN_BRIEF_MAX_PER_SECTION ?? "5", 10) || 5);
// "N majors behind" only counts as debt at this distance — one major behind
// is normal life, not a brief item.
const DEBT_MAJORS_BEHIND = Math.max(1, parseInt(process.env.REPLEN_BRIEF_DEBT_MAJORS ?? "2", 10) || 2);

type BriefItem = { line: string; url: string | null; queueUrl: string | null };
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

// Email queue links are best-effort: signing needs ENCRYPTION_KEY, which a
// minimal self-host might not set — the brief still sends, just without links.
function tryQueueUrl(userId: number, kind: string, refId: number | null, title: string): string | null {
  try { return queueAddUrl(userId, kind, refId, title); } catch { return null; }
}

const majorOf = (v: string): number | null => {
  const m = v.replace(/^v/i, "").match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};

// Build the brief content for one user. Exported for the --dry CLI path.
export async function buildBrief(userId: number, now: Date = new Date()): Promise<Brief> {
  const userTokens = await userTokensFor(userId);
  const brief: Brief = { security: [], breaking: [], bill: [], upgrade: [], total: 0 };
  if (userTokens.size === 0) return brief;
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400e3);
  const versions = await loadUserVersions(userId);

  // Classified events of the week — each lands in ONE section (most urgent).
  const events = await db
    .select({
      id: schema.classifiedEvents.id,
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
    const line = `${name}: ${e.title}`;
    const item = { line, url: e.url, queueUrl: tryQueueUrl(userId, "event", e.id, line) };
    if (e.securityIssue) brief.security.push(item);
    else if (e.willBreakApp) brief.breaking.push(item);
    else if (e.billIncrease) brief.bill.push(item);
    else brief.upgrade.push(item);
  }

  // Pricing changes of the week.
  const priceChanges = await db
    .select({
      id: schema.pricingChanges.id,
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
    const line = `${name}: ${c.summary}`;
    brief.bill.push({ line, url: c.url, queueUrl: tryQueueUrl(userId, "pricing", c.id, line) });
  }

  // Deadlines inside the horizon (incl. just-passed within the grace window).
  // Version-aware, same rules as the footnote: reported versions give
  // per-repo attribution; an EOL whose cycle no reported version matches is
  // verified-unaffected and excluded.
  const deadlines = await db.select().from(schema.deadlineEvents)
    .where(gte(schema.deadlineEvents.deadline, new Date(now.getTime() - 14 * 86400e3)));
  for (const d of deadlines) {
    if (d.deadline.getTime() > now.getTime() + DEADLINE_AHEAD_DAYS * 86400e3) continue;
    if (!tokensMatch(d.detectTokens, userTokens)) continue;
    let affectedStr = "";
    try {
      const toks: string[] = JSON.parse(d.detectTokens ?? "[]");
      const reported = toks.flatMap((t) => versions.get(t) ?? []);
      if (reported.length > 0) {
        const affected = d.kind === "eol" && d.cycle
          ? reported.filter((v) => versionMatchesCycle(v.version, d.cycle!))
          : reported;
        if (affected.length === 0 && d.kind === "eol" && d.cycle) continue; // verified unaffected
        if (affected.length) affectedStr = ` — affects ${affected.slice(0, 3).map((a) => `${a.slug} (${a.version})`).join(", ")}`;
      }
    } catch { /* attribution is best-effort */ }
    const days = Math.round((d.deadline.getTime() - now.getTime()) / 86400e3);
    const what = d.kind === "eol" ? `${d.title} end-of-life` : `${d.product}: ${d.title}`;
    const whenStr = days < 0 ? `passed ${fmtDate(d.deadline)}` : days === 0 ? "TODAY" : `${fmtDate(d.deadline)} (${days}d)`;
    const line = `${what} — ${whenStr}${affectedStr}`;
    brief.upgrade.push({ line, url: d.url, queueUrl: tryQueueUrl(userId, "deadline", d.id, line) });
  }

  // Upgrade debt — only possible with version reports: compare the user's
  // pinned major against the latest stable release stack-watch saw for the
  // same dependency. Two+ majors behind qualifies; one behind is normal life.
  const releases = await db
    .select({ rawJson: schema.candidates.rawJson, postedAt: schema.candidates.postedAt })
    .from(schema.candidates)
    .where(and(
      eq(schema.candidates.userId, userId),
      like(schema.candidates.source, "stack-watch:%"),
      gte(schema.candidates.fetchedAt, new Date(now.getTime() - 60 * 86400e3)),
    ));
  const latestByDep = new Map<string, { tag: string; vendor: string; at: number }>();
  for (const r of releases) {
    try {
      const raw = JSON.parse(r.rawJson ?? "{}") as { depNames?: string[]; tag?: string; vendor?: string };
      if (!raw.tag || !Array.isArray(raw.depNames)) continue;
      const at = r.postedAt?.getTime() ?? 0;
      for (const dep of raw.depNames) {
        const prev = latestByDep.get(dep.toLowerCase());
        if (!prev || at > prev.at) latestByDep.set(dep.toLowerCase(), { tag: raw.tag, vendor: raw.vendor ?? dep, at });
      }
    } catch { /* malformed raw — skip */ }
  }
  const debtSeen = new Set<string>();
  for (const [dep, rel] of latestByDep) {
    const pinned = versions.get(dep);
    if (!pinned?.length) continue;
    const latestMajor = majorOf(rel.tag);
    if (latestMajor == null) continue;
    for (const p of pinned) {
      const userMajor = majorOf(p.version);
      if (userMajor == null || latestMajor - userMajor < DEBT_MAJORS_BEHIND) continue;
      const key = `${dep}:${p.slug}`;
      if (debtSeen.has(key)) continue;
      debtSeen.add(key);
      const line = `${rel.vendor}: ${p.slug} pins ${dep}@${p.version} — latest stable is ${rel.tag} (${latestMajor - userMajor} majors behind)`;
      brief.upgrade.push({ line, url: null, queueUrl: tryQueueUrl(userId, "custom", null, line) });
    }
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
    for (const it of brief[s.key]) {
      lines.push(`  - ${it.line}${it.url ? `\n    ${it.url}` : ""}${it.queueUrl ? `\n    queue for next session: ${it.queueUrl}` : ""}`);
    }
    lines.push("");
  }
  lines.push("Everything above passed the gate: a tool your stack actually uses, answering at least one of the four questions.");
  return lines.join("\n");
}

export function renderBriefHtml(brief: Brief, weekKey: string): string {
  const parts = [
    `<h2 class="r-fg" style="font-weight:600;margin:0 0 4px;font-size:17px;color:${C.fg}">This week in your stack</h2>`,
    `<p class="r-dim" style="color:${C.dim};margin:0 0 18px;font-size:13px">${brief.total} item${brief.total === 1 ? "" : "s"} · ${escapeHtml(weekKey)} · only tools you use, only the four questions</p>`,
  ];
  for (const s of SECTIONS) {
    if (!brief[s.key].length) continue;
    parts.push(`<h3 class="r-fg" style="margin:18px 0 6px;font-size:14px;color:${C.fg}">${escapeHtml(s.q)}</h3><ul style="margin:0;padding-left:18px">`);
    for (const it of brief[s.key]) {
      const body = escapeHtml(it.line);
      const queue = it.queueUrl ? ` <a href="${escapeHref(it.queueUrl)}" class="r-dim" style="color:${C.dim};font-size:12px">queue&nbsp;→</a>` : "";
      parts.push(`<li class="r-fg" style="margin:6px 0;color:${C.fg}">${it.url ? `<a href="${escapeHref(it.url)}" class="r-fg" style="color:${C.fg}">${body}</a>` : body}${queue}</li>`);
    }
    parts.push(`</ul>`);
  }
  parts.push(`<p class="r-faint" style="color:${C.faint};font-size:12px;margin-top:22px">Replen sends this only when something qualified — a quiet week sends nothing.</p>`);
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
      briefFrequency: schema.userSettings.briefFrequency,
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
    // Cadence: weekly (default) / twiceweekly / biweekly / monthly / off. The cron
    // fires twice a week (Mon + Thu). The Thursday "second slot" only goes to
    // twice-weekly users; the Monday slot honours weekly/biweekly/monthly.
    const freq = u.briefFrequency ?? "weekly";
    if (freq === "off") continue;
    const isSecondSlot = now.getUTCDay() >= 4; // Thu run
    const runKey = isSecondSlot ? `${weekKey}-2` : weekKey;
    if (isSecondSlot) {
      if (freq !== "twiceweekly") continue;
    } else {
      const wk = parseInt(weekKey.split("-W")[1] ?? "0", 10);
      if (freq === "biweekly" && wk % 2 !== 0) continue;
      if (freq === "monthly" && now.getUTCDate() > 7) continue;
    }
    const to = u.email; // the account email — the address they signed up with
    if (!to) continue;
    considered++;

    const already = await db.select({ id: schema.briefLog.id }).from(schema.briefLog)
      .where(and(eq(schema.briefLog.userId, u.userId), eq(schema.briefLog.weekKey, runKey))).get();
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
    const unsubUrl = unsubscribeUrl(u.userId, "brief");
    const res = await provider.send({
      from: `${fromName} <${fromAddr}>`,
      to,
      subject,
      html: brandedEmail({
        preheader: subject,
        bodyHtml: renderBriefHtml(brief, weekKey),
        footer: { dashboardUrl: dashboardUrl(), prefsUrl: prefsUrl(), unsubscribeUrl: unsubUrl },
      }),
      text: renderBriefText(brief, weekKey),
      headers: listUnsubHeaders(unsubUrl),
    });
    if (res.ok) {
      sent++;
      await db.insert(schema.briefLog).values({ userId: u.userId, weekKey: runKey, sentAt: now }).onConflictDoNothing();
      console.log(`[brief] sent week ${weekKey} to user=${u.userId} (${brief.total} items)`);
    } else {
      console.warn(`[brief] user=${u.userId} send failed: ${res.error}`);
    }
  }
  console.log(`[brief] done: ${considered} considered, ${sent} sent, ${quiet} quiet`);
  return { considered, sent, quiet };
}
