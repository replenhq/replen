import nodemailer from "nodemailer";
import { db, schema } from "../db/client";
import { desc, eq } from "drizzle-orm";
import type { UserConfig } from "../scheduler/user-config";

type Match = typeof schema.matches.$inferSelect;
type Repo = typeof schema.repos.$inferSelect;
type Project = typeof schema.projectProfiles.$inferSelect;

export async function sendDigestEmail(runId: number, userId: number, cfg: UserConfig) {
  const host = process.env.SES_SMTP_HOST ?? "email-smtp.eu-west-2.amazonaws.com";
  const port = parseInt(process.env.SES_SMTP_PORT ?? "587", 10);
  const user = process.env.SES_SMTP_USERNAME;
  const pass = process.env.SES_SMTP_PASSWORD;
  const fromAddr = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME ?? "replen";
  // User's email destination wins over env fallback.
  const to = cfg.emailToAddress ?? process.env.EMAIL_TO_ADDRESS;

  if (!user || !pass || !fromAddr || !to) {
    console.warn(`[email] user=${userId} missing SES creds or destination; skipping`);
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

  const repoIds = [...new Set(matchesForRun.map((m) => m.repoId))];
  const repoMap = new Map<number, Repo>();
  for (const id of repoIds) {
    const r = await db.select().from(schema.repos).where(eq(schema.repos.id, id)).get();
    if (r) repoMap.set(id, r);
  }
  const projectMap = new Map<number, Project>();
  for (const m of matchesForRun) {
    if (m.projectId && !projectMap.has(m.projectId)) {
      const p = await db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, m.projectId)).get();
      if (p) projectMap.set(m.projectId, p);
    }
  }

  const html = renderHtml(matchesForRun, repoMap, projectMap);
  const text = renderText(matchesForRun, repoMap, projectMap);
  const today = new Date().toISOString().slice(0, 10);

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transport.sendMail({
    from: `"${fromName}" <${fromAddr}>`,
    to,
    subject: `OSS digest - ${today} - ${matchesForRun.length} matches`,
    html,
    text,
  });
  return true;
}

function writeupBody(m: Match): string {
  return (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
}

function relevanceColor(rel: string): { bg: string; fg: string } {
  switch (rel) {
    case "high": return { bg: "#1f8a4c", fg: "#fff" };
    case "medium": return { bg: "#e0a800", fg: "#1a1a1a" };
    case "general-awareness": return { bg: "#6e8aa8", fg: "#fff" };
    case "low": return { bg: "#999", fg: "#fff" };
    default: return { bg: "#444", fg: "#fff" };
  }
}

function renderHtml(matches: Match[], repos: Map<number, Repo>, projects: Map<number, Project>) {
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
  const dashboard = process.env.PUBLIC_BASE_URL ?? "http://localhost:3030";

  // Quick-scan TOC at the top; anchors jump down to each project section.
  const toc = ordered.map(([slug, list]) => {
    const best = Math.max(...list.map((m) => m.relevanceScore ?? 0));
    return `<li style="margin:2px 0"><a href="#${escapeAttr(slug)}" style="color:#1f3a8a;text-decoration:none">${escapeHtml(slug)}</a> <span style="color:#888;font-size:12px">· ${list.length} (best ${best})</span></li>`;
  }).join("");

  let body = "";
  for (const [slug, list] of ordered) {
    const isGeneral = slug === "_general" || slug === "_unknown";
    body += `<h2 id="${escapeAttr(slug)}" style="margin-top:36px;padding:6px 10px;background:${isGeneral ? "#f4f0e8" : "#eef2ff"};border-radius:6px;font-size:16px">${escapeHtml(slug)} <span style="color:#888;font-weight:400;font-size:13px">· ${list.length} ${list.length === 1 ? "match" : "matches"}</span></h2>`;
    for (const m of list) {
      const r = repos.get(m.repoId);
      if (!r) continue;
      const c = relevanceColor(m.relevance);
      const writeupHtml = escapeHtml(writeupBody(m)).replace(/\n/g, "<br/>");
      const srcChip = m.sourceKind
        ? `<span style="display:inline-block;background:#eef;color:#225;border-radius:3px;padding:1px 6px;font-size:11px;margin-left:6px">via ${escapeHtml(m.sourceKind)}</span>`
        : "";
      body += `
        <div style="margin:16px 0;padding:14px;border:1px solid #e5e7eb;border-radius:8px;background:#fff">
          <div style="display:block;margin-bottom:6px">
            <a href="${escapeHref(r.url)}" style="font-size:15px;font-weight:600;color:#1f3a8a;text-decoration:none">${escapeHtml(r.owner)}/${escapeHtml(r.name)}</a>
            <span style="display:inline-block;background:${c.bg};color:${c.fg};border-radius:3px;padding:1px 6px;font-size:11px;font-weight:600;margin-left:6px">${escapeHtml(m.relevance)} ${m.relevanceScore ?? ""}</span>
            ${srcChip}
          </div>
          <div style="color:#888;font-size:12px;margin-bottom:8px">${r.stars ?? 0}★ · ${escapeHtml(r.primaryLanguage ?? "?")} · ${escapeHtml(r.license ?? "no license")}</div>
          <div style="line-height:1.6;font-size:14px;color:#222">${writeupHtml}</div>
        </div>`;
    }
  }

  const header = `
    <div style="border-bottom:2px solid #1f3a8a;padding-bottom:12px;margin-bottom:18px">
      <div style="font-size:13px;color:#888;letter-spacing:0.05em;text-transform:uppercase">◆ replen · ${escapeHtml(today)}</div>
      <h1 style="margin:6px 0 4px;font-size:22px;color:#1a1a1a">${totalMatches} new ${totalMatches === 1 ? "match" : "matches"} today</h1>
      <div style="color:#666;font-size:13px">
        ${highCount > 0 ? `<span style="color:#1f8a4c;font-weight:600">${highCount} high</span>` : ""}${highCount > 0 && (mediumCount + awarenessCount) > 0 ? " · " : ""}
        ${mediumCount > 0 ? `<span style="color:#a67c00;font-weight:600">${mediumCount} medium</span>` : ""}${mediumCount > 0 && awarenessCount > 0 ? " · " : ""}
        ${awarenessCount > 0 ? `<span style="color:#6e8aa8;font-weight:600">${awarenessCount} awareness</span>` : ""}
      </div>
    </div>
    ${toc ? `<details open style="margin-bottom:18px"><summary style="cursor:pointer;font-size:13px;color:#444;font-weight:600">Jump to project</summary><ul style="margin:8px 0 0;padding-left:20px;font-size:13px">${toc}</ul></details>` : ""}
  `;

  const footer = `
    <div style="margin-top:36px;padding-top:18px;border-top:1px solid #e5e7eb;color:#888;font-size:12px;line-height:1.6">
      Open the <a href="${escapeHref(dashboard)}" style="color:#1f3a8a">dashboard</a> to star, hide, or open a handoff PR. Reply to this email and nothing happens; we don't read replies.
    </div>
  `;

  return `<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;max-width:760px;margin:auto;color:#222;padding:24px;background:#fafafa">${header}${body}${footer}</body></html>`;
}

function escapeAttr(s: string) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

// Stricter helper for href values. Only http(s) and in-page fragments are
// allowed; anything else (javascript:, data:, vbscript:, file:) collapses to
// an inert `#`. Use this for every `<a href="${...}">` rendered from
// user-controlled or LLM-touched data.
function escapeHref(s: string) {
  const t = String(s ?? "").trim();
  if (t.startsWith("#")) return escapeAttr(t);
  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:") return escapeAttr(u.toString());
  } catch {
    // fall through
  }
  return "#";
}

function renderText(matches: Match[], repos: Map<number, Repo>, projects: Map<number, Project>) {
  return matches
    .map((m) => {
      const r = repos.get(m.repoId);
      const p = m.projectId ? projects.get(m.projectId)?.slug ?? "_unknown" : "_general";
      return `[${p}] ${r?.owner}/${r?.name} (${m.relevance} ${m.relevanceScore ?? ""}, ${r?.stars ?? 0}★, ${r?.license ?? "no license"})\n${r?.url}\n\n${writeupBody(m)}`;
    })
    .join("\n\n- - -\n\n");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
