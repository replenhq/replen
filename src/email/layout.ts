// Shared branded email shell. MONOCHROME (the logo is black/white, so accents are
// too — no colour). Theme = the device's local setting: LIGHT by default, flipping to
// dark on dark-mode devices. Inline LIGHT styles are the universal base (what Gmail +
// every client show); a <head> <style> block adds dark overrides inside
// @media (prefers-color-scheme: dark) via .r-* classes, and swaps the ink logo for the
// off-white one. Apple Mail / iOS honour the device setting; Gmail shows the light base.

import { escapeHtml, escapeHref } from "./escape";

// LIGHT palette = the inline default (and fallback). Dark values live in STYLE below.
// Monochrome only — links read via underline, not colour. (red kept for the one
// genuine severity signal: critical security alerts.)
export const C = {
  bg: "#f4f5f7",
  card: "#ffffff",
  raised: "#f6f6f8",
  border: "#e6e7ea",
  fg: "#1a1a1a",
  dim: "#5f6570",
  faint: "#9499a3",
  red: "#b91c1c",
} as const;
export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// Absolute base for hosted email assets (the logo). The WEBAPP host (app.replen.dev)
// serves /public; PUBLIC_BASE_URL is the skill-tier API host which 302-redirects.
const ASSET_BASE = (process.env.CLI_PUBLIC_BASE_URL ?? "https://app.replen.dev").replace(/\/+$/, "");

// Dark overrides only — the inline styles already carry the light base. Also swaps
// the ink logo (default) for the off-white one on dark devices.
const STYLE = `:root{color-scheme:light dark;}
.r-img-dark{display:none;}
@media (prefers-color-scheme:dark){
.r-bg{background:#0a0b0d !important;}
.r-card{background:#141518 !important;border-color:#26282d !important;color:#ece9e2 !important;}
.r-fg{color:#ece9e2 !important;}
.r-dim{color:#9d9a93 !important;}
.r-faint{color:#66645e !important;}
.r-red{color:#f08a7a !important;}
.r-raised{background:#1c1e22 !important;border-color:#26282d !important;}
.r-btn{background:#ece9e2 !important;color:#0a0b0d !important;}
.r-img-light{display:none !important;}
.r-img-dark{display:inline-block !important;}
}`;

export type BrandFooter = { dashboardUrl?: string; prefsUrl?: string; unsubscribeUrl?: string };

export function brandedEmail(opts: { preheader?: string; bodyHtml: string; footer?: BrandFooter }): string {
  const { preheader, bodyHtml, footer } = opts;
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>`
    : "";

  const links: string[] = [];
  if (footer?.dashboardUrl) links.push(`<a href="${escapeHref(footer.dashboardUrl)}" class="r-fg" style="color:${C.fg};text-decoration:underline">Dashboard</a>`);
  if (footer?.prefsUrl) links.push(`<a href="${escapeHref(footer.prefsUrl)}" class="r-fg" style="color:${C.fg};text-decoration:underline">Email preferences</a>`);
  if (footer?.unsubscribeUrl) links.push(`<a href="${escapeHref(footer.unsubscribeUrl)}" class="r-dim" style="color:${C.dim};text-decoration:underline">Unsubscribe</a>`);
  const footerLinks = links.length ? `<div style="margin-bottom:10px">${links.join(` <span class="r-faint" style="color:${C.faint}">&middot;</span> `)}</div>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>${STYLE}</style></head>` +
    `<body class="r-bg" style="margin:0;padding:0;background:${C.bg};">${pre}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" class="r-bg" style="background:${C.bg};width:100%;">` +
      `<tr><td align="center" style="padding:28px 14px;">` +
        `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">` +
          `<tr><td style="padding:2px 6px 18px;">` +
            // App wordmark: black/white screen-glyph (ink for light, off-white for dark —
            // swapped via the media query) + "Replen". Matches the real b/w logo.
            `<img class="r-img-light" src="${ASSET_BASE}/email-glyph-light.png" width="30" height="20" alt="" style="vertical-align:middle;display:inline-block;border:0" />` +
            `<img class="r-img-dark" src="${ASSET_BASE}/email-glyph-dark.png" width="30" height="20" alt="" style="vertical-align:middle;display:none;border:0" />` +
            `<span class="r-fg" style="font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${C.fg};vertical-align:middle;margin-left:9px">Replen</span>` +
          `</td></tr>` +
          `<tr><td class="r-card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:22px 22px 24px;color:${C.fg};font-family:${FONT};font-size:14px;line-height:1.6;">` +
            bodyHtml +
          `</td></tr>` +
          `<tr><td class="r-faint" style="padding:18px 8px 0;text-align:center;color:${C.faint};font-size:12px;line-height:1.7;font-family:${FONT};">` +
            footerLinks +
            `<div>Smarter AI development workflows.</div>` +
            `<div style="margin-top:5px">Sent from btw@replen.dev &middot; replies aren't read.</div>` +
          `</td></tr>` +
        `</table>` +
      `</td></tr>` +
    `</table></body></html>`;
}

/** List-Unsubscribe + one-click POST headers. Pass the signed unsubscribe URL. */
export function listUnsubHeaders(url?: string): Record<string, string> {
  if (!url) return {};
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
