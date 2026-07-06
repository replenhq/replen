// Announcement surfacing — the calm half of the announcement layer.
//
// THE GATE: an event reaches a user only when (a) its source's detect tokens
// hit the user's deps/tags — they actually use the tool — AND (b) the event
// answers at least one of the four product questions (will this break my app /
// security issue / bill increase / upgrade needed). Everything else stays in
// the database, never in the footnote.
//
// Shape: one line, once per (user, event), severity-aware. Critical events
// LEAD the footnote ("Heads up — ..."); everything else is a P.s. The
// inventory route composes this with the pricing watch line and keeps at most
// one of them per response.

import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client";
import { EVENT_LABELS, SEVERITY_ORDER, type Severity } from "./classify";
import { loadUserVersions } from "./deadlines";
import { sanitizeForMarkdown } from "../lib/handoff-template";

const SURFACE_WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_ANNOUNCE_SURFACE_DAYS ?? "10", 10) || 10);

// Vendor-agnostic sources (security news, aggregators) report about OTHER
// vendors' products — their own detect tokens identify nobody. For those, the
// affected product lives in the TITLE, so we match user tokens against the
// title text instead, with a higher bar: High/Critical only, token length ≥4,
// and a blocklist of tokens that double as common headline English.
const AGGREGATOR_CATEGORY = /aggregator|security news|security research|exploit intelligence|breach/i;
// Multi-topic news DIGESTS (weekly recaps, roundups, newsletters) are never a single
// actionable item — they list a dozen unrelated stories, so a loose title-token match
// is spurious. Never surface them as a stack alert (the "⚡ Weekly Recap…" false alarm).
const ROUNDUP_TITLE = /weekly recap|week in review|this week in|round-?up|newsletter|in brief|top \d+|digest|recap:|bulletin|wrap-?up|what'?s new this week/i;
// Strip emojis / pictographs from a source headline so the footnote doesn't echo
// clickbait (e.g. a leading "⚡"). Covers the common emoji + symbol blocks.
const stripEmoji = (s: string) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "");
const TITLE_MATCH_BLOCKLIST = new Set([
  "next", "make", "with", "this", "that", "from", "your", "into", "over", "after",
  "data", "cloud", "security", "critical", "update", "release", "major", "flaw",
  "flaws", "bugs", "apps", "code", "users", "attack", "report", "rust", "shell",
]);

// `token` — the matched detect-token (user-side tool identity) when the event
// is vendor-anchored; null for aggregator title-matches (no single tool).
export type AnnouncementPs = { eventId: number; line: string; severity: Severity; critical: boolean; token: string | null };

export async function announcementPs(userId: number, userTokens: Set<string>): Promise<AnnouncementPs | null> {
  if (userTokens.size === 0) return null;
  const since = new Date(Date.now() - SURFACE_WINDOW_DAYS * 24 * 3600 * 1000);
  const events = await db
    .select({
      id: schema.classifiedEvents.id,
      eventType: schema.classifiedEvents.eventType,
      severity: schema.classifiedEvents.severity,
      title: schema.classifiedEvents.title,
      url: schema.classifiedEvents.url,
      detectedAt: schema.classifiedEvents.detectedAt,
      willBreakApp: schema.classifiedEvents.willBreakApp,
      securityIssue: schema.classifiedEvents.securityIssue,
      billIncrease: schema.classifiedEvents.billIncrease,
      upgradeNeeded: schema.classifiedEvents.upgradeNeeded,
      vendor: schema.announcementSources.vendor,
      product: schema.announcementSources.product,
      category: schema.announcementSources.category,
      detectTokens: schema.announcementSources.detectTokens,
    })
    .from(schema.classifiedEvents)
    .innerJoin(schema.announcementSources, eq(schema.classifiedEvents.sourcePk, schema.announcementSources.id))
    .where(gte(schema.classifiedEvents.detectedAt, since));
  if (!events.length) return null;

  const seen = new Set(
    (await db.select({ eventId: schema.announcementSurfaces.eventId }).from(schema.announcementSurfaces)
      .where(eq(schema.announcementSurfaces.userId, userId))).map((r) => r.eventId),
  );

  // Tokens usable for title matching on aggregator-sourced events.
  const titleTokens = [...userTokens].filter((t) => t.length >= 4 && !TITLE_MATCH_BLOCKLIST.has(t));

  const eligible = events
    .filter((e) => !seen.has(e.id))
    .filter((e) => e.willBreakApp || e.securityIssue || e.billIncrease || e.upgradeNeeded) // the four-questions gate
    .filter((e) => !ROUNDUP_TITLE.test(e.title)) // multi-topic digests are never a single actionable alert
    .filter((e) => {
      if (AGGREGATOR_CATEGORY.test(e.category ?? "")) {
        if (SEVERITY_ORDER[e.severity as Severity] < SEVERITY_ORDER.High) return false;
        const title = ` ${e.title.toLowerCase()} `;
        return titleTokens.some((t) => new RegExp(`\\b${t.replace(/[^a-z0-9]/g, "\\$&")}\\b`, "i").test(title));
      }
      let toks: string[] = [];
      try { toks = JSON.parse(e.detectTokens ?? "[]"); } catch { /* */ }
      return toks.some((t) => userTokens.has(t));
    })
    .sort((a, b) =>
      (SEVERITY_ORDER[b.severity as Severity] ?? 0) - (SEVERITY_ORDER[a.severity as Severity] ?? 0) ||
      b.detectedAt.getTime() - a.detectedAt.getTime());
  if (!eligible.length) return null;

  const e = eligible[0];
  const severity = (e.severity as Severity) ?? "Medium";
  const critical = severity === "Critical";
  const label = EVENT_LABELS[e.eventType] ?? "announcement";
  const title = stripEmoji(e.title).replace(/\s+/g, " ").trim().slice(0, 120);
  // Version reports give name-level attribution: which repos use the tool.
  let inRepos = "";
  try {
    const versions = await loadUserVersions(userId);
    const toks: string[] = JSON.parse(e.detectTokens ?? "[]");
    const slugs = [...new Set(toks.flatMap((t) => (versions.get(t) ?? []).map((v) => v.slug)))];
    if (slugs.length) inRepos = ` (in ${slugs.slice(0, 3).map((s) => `\`${s}\``).join(", ")})`;
  } catch { /* attribution is best-effort */ }
  let line: string;
  if (AGGREGATOR_CATEGORY.test(e.category ?? "")) {
    // The headline names the affected vendor; the aggregator's name is noise. Only
    // claim it "touches your stack" when a version-confirmed dependency is actually
    // named (inRepos). A bare title-token match (a common word in a security headline)
    // is too weak to alarm — soften to a low-key "in security news" mention.
    line = inRepos
      ? (critical
          ? `Heads up — ${label}: "${title}". This touches your stack${inRepos} — worth checking now.`
          : `${label} in the news: "${title}" — touches your stack${inRepos}, worth a look.`)
      : `${label} in security news: "${title}" — might be worth a glance.`;
  } else {
    const name = e.product.toLowerCase().includes(e.vendor.toLowerCase().split(" ")[0]) || e.product === e.vendor
      ? e.product
      : `${e.vendor} ${e.product}`;
    line = critical
      ? `Heads up — ${name} ${label}: "${title}". You use this${inRepos} — worth checking now.`
      : `${name} posted a ${label}: "${title}"${inRepos} — worth a look.`;
  }
  let eToks: string[] = [];
  try { eToks = JSON.parse(e.detectTokens ?? "[]"); } catch { /* */ }
  const token = AGGREGATOR_CATEGORY.test(e.category ?? "") ? null : eToks.find((t) => userTokens.has(t)) ?? null;
  // The headline (e.title / vendor / product) is untrusted scraped text and the
  // line is relayed VERBATIM into the user's coding agent as Replen's voice.
  // Sanitize to the same bar as candidate descriptions (strip HTML/control/
  // zero-width/bidi, defang script schemes) so a crafted feed title can't inject.
  return { eventId: e.id, line: sanitizeForMarkdown(line), severity, critical, token };
}
