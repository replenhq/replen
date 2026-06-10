// Instant critical alerts — the other half of always-on delivery.
//
// When the announcement poller classifies a CRITICAL event (actively
// exploited vuln, breach, malicious package, credential exposure) affecting a
// tool a user's stack uses, they should hear about it on the alert channel,
// not at their next coding session. One alert per (user, event, channel),
// ever. Runs right after each poll cycle; the recency window keeps a stalled
// cron from dumping old criticals when it wakes up.

import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client";
import { pickEmailProvider } from "../email/providers";
import { escapeHtml, escapeHref } from "../email/escape";
import { userToolTokens } from "../lib/detect-tokens";
import { parseTechSummaryDeps } from "../fetchers/stack-watch/registry";
import { EVENT_LABELS } from "../announcements/classify";
import { loadUserVersions } from "../announcements/deadlines";
import { queueAddUrl } from "../lib/queue-sign";

const ALERT_WINDOW_HOURS = Math.max(1, parseInt(process.env.REPLEN_ALERT_WINDOW_HOURS ?? "48", 10) || 48);

export async function processCriticalAlerts(): Promise<{ alerts: number }> {
  const now = new Date();
  const since = new Date(now.getTime() - ALERT_WINDOW_HOURS * 3600e3);
  const criticals = await db
    .select({
      id: schema.classifiedEvents.id,
      eventType: schema.classifiedEvents.eventType,
      title: schema.classifiedEvents.title,
      summary: schema.classifiedEvents.summary,
      url: schema.classifiedEvents.url,
      vendor: schema.announcementSources.vendor,
      product: schema.announcementSources.product,
      category: schema.announcementSources.category,
      detectTokens: schema.announcementSources.detectTokens,
    })
    .from(schema.classifiedEvents)
    .innerJoin(schema.announcementSources, eq(schema.classifiedEvents.sourcePk, schema.announcementSources.id))
    .where(and(eq(schema.classifiedEvents.severity, "Critical"), gte(schema.classifiedEvents.detectedAt, since)));
  if (!criticals.length) return { alerts: 0 };

  const users = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      emailToAddress: schema.userSettings.emailToAddress,
      enabled: schema.userSettings.enabled,
    })
    .from(schema.users)
    .innerJoin(schema.userSettings, eq(schema.userSettings.userId, schema.users.id));

  const fromAddr = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME ?? "Replen";
  const provider = pickEmailProvider();
  if (!provider || !fromAddr) {
    console.warn("[alerts] no email provider / EMAIL_FROM_ADDRESS configured; skipping");
    return { alerts: 0 };
  }

  let alerts = 0;
  for (const u of users) {
    if (!u.enabled) continue;
    const to = u.emailToAddress ?? u.email;
    if (!to) continue;
    const userTokens = await loadUserTokens(u.userId);
    if (userTokens.size === 0) continue;

    for (const c of criticals) {
      // Vendor-anchored sources match by tokens; aggregator events match by
      // title (same contract as the footnote — see announcements/surface.ts).
      let toks: string[] = [];
      try { toks = JSON.parse(c.detectTokens ?? "[]"); } catch { /* */ }
      const aggregator = /aggregator|security news|security research|exploit intelligence|breach/i.test(c.category ?? "");
      const matched = aggregator
        ? [...userTokens].some((t) => t.length >= 4 && new RegExp(`\\b${t.replace(/[^a-z0-9]/g, "\\$&")}\\b`, "i").test(c.title))
        : toks.some((t) => userTokens.has(t));
      if (!matched) continue;

      const dup = await db.select({ id: schema.alertLog.id }).from(schema.alertLog)
        .where(and(eq(schema.alertLog.userId, u.userId), eq(schema.alertLog.eventId, c.id), eq(schema.alertLog.channel, "email"))).get();
      if (dup) continue;

      const label = EVENT_LABELS[c.eventType] ?? "critical event";
      const name = aggregator ? null : (c.product === c.vendor ? c.vendor : `${c.vendor} ${c.product}`);
      // Name-level attribution from version reports, when available.
      let affectedLine = "";
      try {
        const versions = await loadUserVersions(u.userId);
        const slugs = [...new Set(toks.flatMap((t) => (versions.get(t) ?? []).map((v) => `${v.slug} (${v.version})`)))];
        if (slugs.length) affectedLine = `Affects: ${slugs.slice(0, 5).join(", ")}`;
      } catch { /* best-effort */ }
      const subject = `Replen alert: ${label}${name ? ` — ${name}` : ""}`;
      const lineText = `${c.title}\n\n${c.summary ?? ""}\n${affectedLine ? `\n${affectedLine}\n` : ""}\n${c.url ?? ""}\n\nThis reached you because your stack uses an affected tool. Open your repo and run /replen for a grounded read.`;
      const html = [
        `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">`,
        `<h2 style="font-weight:600">⚠ ${escapeHtml(label)}${name ? ` — ${escapeHtml(name)}` : ""}</h2>`,
        `<p><strong>${escapeHtml(c.title)}</strong></p>`,
        c.summary ? `<p style="color:#444">${escapeHtml(c.summary)}</p>` : "",
        affectedLine ? `<p style="color:#b00"><strong>${escapeHtml(affectedLine)}</strong></p>` : "",
        c.url ? `<p><a href="${escapeHref(c.url)}">Source</a></p>` : "",
        (() => {
          try {
            const q = queueAddUrl(u.userId, "event", c.id, c.title.slice(0, 140));
            return `<p><a href="${escapeHref(q)}" style="color:#6b7280">Queue for my next coding session →</a></p>`;
          } catch { return ""; }
        })(),
        `<p style="color:#999;font-size:12px;margin-top:24px">Sent because your stack uses an affected tool. One alert per event, ever.</p></div>`,
      ].join("\n");

      const res = await provider.send({ from: `${fromName} <${fromAddr}>`, to, subject, html, text: lineText });
      if (res.ok) {
        alerts++;
        await db.insert(schema.alertLog).values({ userId: u.userId, eventId: c.id, channel: "email", sentAt: now }).onConflictDoNothing();
        console.log(`[alerts] CRITICAL → user=${u.userId}: ${c.title.slice(0, 80)}`);
      } else {
        console.warn(`[alerts] user=${u.userId} send failed: ${res.error}`);
      }
    }
  }
  if (alerts) console.log(`[alerts] done: ${alerts} alert(s) sent`);
  return { alerts };
}

async function loadUserTokens(userId: number): Promise<Set<string>> {
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
