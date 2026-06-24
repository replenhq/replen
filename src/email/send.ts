import { db, schema } from "../db/client";
import { desc, eq, inArray } from "drizzle-orm";
import type { UserConfig } from "../scheduler/user-config";
import { pickEmailProvider } from "./providers";
import { brandedEmail, listUnsubHeaders, C } from "./layout";
import { unsubscribeUrl, prefsUrl, dashboardUrl } from "../lib/unsub-sign";
import { escapeAttr as escapeAttrShared, escapeHref as escapeHrefShared, escapeHtml as escapeHtmlShared } from "./escape";

type Match = typeof schema.matches.$inferSelect;
type Repo = typeof schema.repos.$inferSelect;
type Project = typeof schema.projectProfiles.$inferSelect;

export async function sendDigestEmail(runId: number, userId: number, cfg: UserConfig) {
  const fromAddr = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME ?? "Replen";
  // Audit L7: in solo/single-user mode (AUTH_MODE=solo), EMAIL_TO_ADDRESS
  // is the legitimate fallback. In multi-user mode (AUTH_MODE=firebase,
  // default in prod), falling back to the env address means a misconfigured
  // user's digest lands in the admin's inbox — content leak across tenants.
  // Require explicit per-user emailToAddress in multi-user mode.
  const isMultiUser = (process.env.AUTH_MODE ?? "firebase") !== "solo";
  // Send to the account email (the address they signed up with). A solo install
  // with no account email may still fall back to EMAIL_TO_ADDRESS.
  const account = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).get();
  const to = account?.email ?? (isMultiUser ? null : process.env.EMAIL_TO_ADDRESS);

  if (!fromAddr || !to) {
    console.warn(`[email] user=${userId} missing from-address or destination; skipping`);
    return false;
  }
  const provider = pickEmailProvider();
  if (!provider) {
    console.warn(`[email] user=${userId} no usable email provider configured; skipping`);
    return false;
  }

  // Per-channel preference: the digest can be turned off (account settings, or the
  // signed unsubscribe link with scope=digest) without flipping the master switch.
  const prefs = await db
    .select({ digestEnabled: schema.userSettings.digestEnabled })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  if (prefs && !prefs.digestEnabled) {
    console.log(`[email] user=${userId} digest disabled in preferences; skipping`);
    return false;
  }

  const matchesForRun = await db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.runId, runId))
    .orderBy(desc(schema.matches.relevanceScore));
  // safety: matches table has userId column too; verify all belong to this user.
  // (runId is already per-user by construction; this is belt-and-braces.)
  for (const m of matchesForRun) {
    if (m.userId !== null && m.userId !== userId) {
      throw new Error(`[email] cross-user leak detected for match ${m.id}`);
    }
  }

  if (matchesForRun.length === 0) {
    console.log("[email] no matches for this run; skipping");
    return false;
  }

  // Calm-utility cadence: only send when there's at least one high or
  // medium match. General-awareness alone isn't worth interrupting the
  // user's inbox — those still surface on the dashboard but the email
  // is reserved for "act on this." Matches the 1-3-useful-things-per-
  // month positioning rather than a daily-digest cadence.
  const actionableCount = matchesForRun.filter(
    (m) => m.relevance === "high" || m.relevance === "medium",
  ).length;
  if (actionableCount === 0) {
    console.log(`[email] user=${userId} ${matchesForRun.length} matches but none high/medium; skipping (calm cadence)`);
    return false;
  }

  const repoIds = [...new Set(matchesForRun.map((m) => m.repoId))];
  const repoMap = new Map<number, Repo>();
  if (repoIds.length > 0) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repoMap.set(r.id, r);
  }
  const projectIds = [...new Set(matchesForRun.map((m) => m.projectId).filter((id): id is number => id !== null))];
  const projectMap = new Map<number, Project>();
  if (projectIds.length > 0) {
    const ps = await db.select().from(schema.projectProfiles).where(inArray(schema.projectProfiles.id, projectIds));
    for (const p of ps) projectMap.set(p.id, p);
  }

  // For resurfaced rows, fetch the origin bookmark's createdAt so the email
  // can show "From your bookmarks — saved <date>".
  const resurfaceIds = [...new Set(matchesForRun.map((m) => m.resurfacedFromMatchId).filter((x): x is number => !!x))];
  const bookmarkDateById = new Map<number, Date>();
  if (resurfaceIds.length > 0) {
    const orig = await db
      .select({ id: schema.matches.id, createdAt: schema.matches.createdAt })
      .from(schema.matches)
      .where(inArray(schema.matches.id, resurfaceIds));
    for (const o of orig) bookmarkDateById.set(o.id, o.createdAt);
  }

  const html = renderHtml(matchesForRun, repoMap, projectMap, bookmarkDateById, userId);
  const text = renderText(matchesForRun, repoMap, projectMap);

  // Value-led subject line. The user is going to make a single yes/no
  // decision on whether to open this email — that decision should be
  // about the substance of the top match, not a date stamp. Shape:
  //   1 match: "Replace fluent-ffmpeg in tech-news-site (medium)"
  //   2+:      "Drop fluent-ffmpeg in tech-news-site + 2 more (high)"
  // Old subject "Replen digest - 2026-05-22 - 27 matches" tested as
  // pure noise — date is in the email client's own metadata, the count
  // sounds like spam.
  const subject = buildSubject(matchesForRun, repoMap, projectMap);

  const r = await provider.send({
    from: `"${fromName}" <${fromAddr}>`,
    to,
    subject,
    html,
    text,
    headers: listUnsubHeaders(unsubscribeUrl(userId, "digest")),
  });
  if (!r.ok) {
    console.error(`[email] user=${userId} send failed via ${provider.name}: ${r.error}`);
    return false;
  }
  return true;
}

function writeupBody(m: Match): string {
  return (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
}

/** Compose the email subject from the highest-scored actionable match.
 *  Skips general-awareness when picking the top; if the run is entirely
 *  general-awareness this caller is already short-circuited upstream.
 */
function buildSubject(matches: Match[], repos: Map<number, Repo>, projects: Map<number, Project>): string {
  const actionable = matches.filter((m) => m.relevance === "high" || m.relevance === "medium");
  // Pick the top by score; ties broken by relevance (high > medium).
  const top = [...actionable].sort((a, b) => {
    if (a.relevance !== b.relevance) return a.relevance === "high" ? -1 : 1;
    return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
  })[0];
  if (!top) return "Replen — new matches"; // belt + braces; shouldn't hit
  const repo = repos.get(top.repoId);
  const projSlug = top.projectId ? projects.get(top.projectId)?.slug ?? null : null;
  const inProject = projSlug ? ` in ${projSlug}` : "";
  const more = actionable.length - 1;
  const moreSuffix = more > 0 ? ` + ${more} more` : "";
  const tierSuffix = ` (${top.relevance})`;

  // Prune actions get a verb-led headline: "Drop X" or "Replace X with Y."
  // Stronger signal than the repo name for prune matches because the
  // user thinks in terms of "what should I remove" not "what new repo."
  if (top.discoveryMode === "prune" && top.prunedDepName) {
    const dep = top.prunedDepName;
    if (top.prunedDepAction === "replace" && top.prunedDepReplacement) {
      return `Replace ${dep} with ${top.prunedDepReplacement}${inProject}${moreSuffix}${tierSuffix}`;
    }
    if (top.prunedDepAction === "drop") {
      return `Drop ${dep}${inProject}${moreSuffix}${tierSuffix}`;
    }
  }
  // Non-prune: repo name + project + tier.
  const repoLabel = repo ? `${repo.owner}/${repo.name}` : "new match";
  return `${repoLabel}${inProject}${moreSuffix}${tierSuffix}`;
}

function relevanceColor(_rel: string): { bg: string; fg: string } {
  // Monochrome: one neutral chip for every tier (the "high 85" text carries the tier).
  return { bg: C.raised, fg: C.dim };
}

function renderHtml(matches: Match[], repos: Map<number, Repo>, projects: Map<number, Project>, bookmarkDateById: Map<number, Date>, userId: number) {
  const grouped = new Map<string, Match[]>();
  for (const m of matches) {
    const key = m.projectId ? projects.get(m.projectId)?.slug ?? "_unknown" : "_general";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(m);
  }
  // Project-specific groups first (ranked by best score); _general / _unknown
  // always pinned to the bottom; awareness, not project-fit.
  const ordered = [...grouped.entries()].sort((a, b) => {
    const aGen = a[0] === "_general" || a[0] === "_unknown";
    const bGen = b[0] === "_general" || b[0] === "_unknown";
    if (aGen !== bGen) return aGen ? 1 : -1;
    const sa = Math.max(...a[1].map((m) => m.relevanceScore ?? 0));
    const sb = Math.max(...b[1].map((m) => m.relevanceScore ?? 0));
    return sb - sa;
  });

  const today = new Date().toISOString().slice(0, 10);
  const totalMatches = matches.length;
  const highCount = matches.filter((m) => m.relevance === "high").length;
  const mediumCount = matches.filter((m) => m.relevance === "medium").length;
  const awarenessCount = matches.filter((m) => m.relevance === "general-awareness").length;
  const dashboard = dashboardUrl();

  // Quick-scan TOC at the top; anchors jump down to each project section.
  const toc = ordered.map(([slug, list]) => {
    const best = Math.max(...list.map((m) => m.relevanceScore ?? 0));
    return `<li style="margin:2px 0"><a href="#${escapeAttr(slug)}" class="r-fg" style="color:${C.fg};text-decoration:underline">${escapeHtml(slug)}</a> <span class="r-dim" style="color:${C.dim};font-size:12px">· ${list.length} (best ${best})</span></li>`;
  }).join("");

  let body = "";
  for (const [slug, list] of ordered) {
    body += `<h2 id="${escapeAttr(slug)}" class="r-raised r-fg" style="margin-top:30px;padding:6px 10px;background:${C.raised};border-radius:6px;font-size:15px;color:${C.fg}">${escapeHtml(slug)} <span class="r-dim" style="color:${C.dim};font-weight:400;font-size:13px">· ${list.length} ${list.length === 1 ? "match" : "matches"}</span></h2>`;
    for (const m of list) {
      const r = repos.get(m.repoId);
      if (!r) continue;
      const c = relevanceColor(m.relevance);
      const writeupHtml = escapeHtml(writeupBody(m)).replace(/\n/g, "<br/>");
      const srcChip = m.sourceKind
        ? `<span class="r-raised r-dim" style="display:inline-block;background:${C.raised};color:${C.dim};border-radius:3px;padding:1px 6px;font-size:11px;margin-left:6px">via ${escapeHtml(m.sourceKind)}</span>`
        : "";
      let modeChip = "";
      if (m.discoveryMode === "re-checked" && m.resurfacedFromMatchId) {
        const bd = bookmarkDateById.get(m.resurfacedFromMatchId);
        const dateStr = bd ? bd.toISOString().slice(0, 10) : "earlier";
        modeChip = `<span class="r-raised r-dim" style="display:inline-block;background:${C.raised};color:${C.dim};border-radius:3px;padding:1px 6px;font-size:11px;margin-left:6px">Re-checked from your bookmarks — saved ${escapeHtml(dateStr)}</span>`;
      } else if (m.discoveryMode === "discovered") {
        modeChip = `<span class="r-raised r-dim" style="display:inline-block;background:${C.raised};color:${C.dim};border-radius:3px;padding:1px 6px;font-size:11px;margin-left:6px">Discovered</span>`;
      } else if (m.discoveryMode === "scouted" && m.matchedOutcome) {
        modeChip = `<span class="r-raised r-dim" style="display:inline-block;background:${C.raised};color:${C.dim};border-radius:3px;padding:1px 6px;font-size:11px;margin-left:6px">Scouted</span>`;
      }
      body += `
        <div class="r-raised" style="margin:14px 0;padding:14px;border:1px solid ${C.border};border-radius:8px;background:${C.raised}">
          <div style="display:block;margin-bottom:6px">
            <a href="${escapeHref(r.url)}" class="r-fg" style="font-size:15px;font-weight:600;color:${C.fg};text-decoration:underline">${escapeHtml(r.owner)}/${escapeHtml(r.name)}</a>
            <span class="r-raised r-dim" style="display:inline-block;background:${c.bg};color:${c.fg};border:1px solid ${C.border};border-radius:3px;padding:1px 6px;font-size:11px;font-weight:600;margin-left:6px">${escapeHtml(m.relevance)} ${m.relevanceScore ?? ""}</span>
            ${modeChip}
            ${srcChip}
          </div>
          <div class="r-dim" style="color:${C.dim};font-size:12px;margin-bottom:8px">${r.stars ?? 0}★ · ${escapeHtml(r.primaryLanguage ?? "?")} · ${escapeHtml(r.license ?? "no license")}</div>
          <div class="r-fg" style="line-height:1.6;font-size:14px;color:${C.fg}">${writeupHtml}</div>
        </div>`;
    }
  }

  const header = `
    <div style="border-bottom:1px solid ${C.border};padding-bottom:12px;margin-bottom:18px">
      <div class="r-dim" style="font-size:13px;color:${C.dim};letter-spacing:0.05em;text-transform:uppercase">${escapeHtml(today)}</div>
      <h1 class="r-fg" style="margin:6px 0 4px;font-size:22px;color:${C.fg}">${totalMatches} new ${totalMatches === 1 ? "match" : "matches"} today</h1>
      <div class="r-dim" style="color:${C.dim};font-size:13px">
        ${highCount > 0 ? `<span class="r-fg" style="color:${C.fg};font-weight:600">${highCount} high</span>` : ""}${highCount > 0 && (mediumCount + awarenessCount) > 0 ? " · " : ""}
        ${mediumCount > 0 ? `<span class="r-fg" style="color:${C.fg};font-weight:600">${mediumCount} medium</span>` : ""}${mediumCount > 0 && awarenessCount > 0 ? " · " : ""}
        ${awarenessCount > 0 ? `<span class="r-dim" style="color:${C.dim};font-weight:600">${awarenessCount} awareness</span>` : ""}
      </div>
    </div>
    ${toc ? `<details open style="margin-bottom:18px"><summary class="r-dim" style="cursor:pointer;font-size:13px;color:${C.dim};font-weight:600">Jump to project</summary><ul style="margin:8px 0 0;padding-left:20px;font-size:13px">${toc}</ul></details>` : ""}
  `;

  return brandedEmail({
    preheader: `${highCount} high${mediumCount ? ` · ${mediumCount} medium` : ""}${awarenessCount ? ` · ${awarenessCount} awareness` : ""}`,
    bodyHtml: `${header}${body}`,
    footer: {
      dashboardUrl: dashboard,
      prefsUrl: prefsUrl(),
      unsubscribeUrl: unsubscribeUrl(userId, "digest"),
    },
  });
}

const escapeAttr = escapeAttrShared;
const escapeHref = escapeHrefShared;

function renderText(matches: Match[], repos: Map<number, Repo>, projects: Map<number, Project>) {
  return matches
    .map((m) => {
      const r = repos.get(m.repoId);
      const p = m.projectId ? projects.get(m.projectId)?.slug ?? "_unknown" : "_general";
      return `[${p}] ${r?.owner}/${r?.name} (${m.relevance} ${m.relevanceScore ?? ""}, ${r?.stars ?? 0}★, ${r?.license ?? "no license"})\n${r?.url}\n\n${writeupBody(m)}`;
    })
    .join("\n\n- - -\n\n");
}

const escapeHtml = escapeHtmlShared;
