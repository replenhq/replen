import { pickEmailProvider } from "./providers";
import { brandedEmail, C } from "./layout";
import { dashboardUrl } from "../lib/unsub-sign";
import { escapeHtml, escapeHref } from "./escape";

// Sends an invite email when an admin adds a new user. The user then visits
// the app, signs in with Firebase using the invited email address, and their
// pre-created placeholder row (firebase_uid: "invited:<email>") is upgraded
// to a real uid on first login (see src/lib/auth/current-user.ts).
//
// Returns true on success. Logs and returns false on failure so the calling
// admin action doesn't crash if email is misconfigured; the user row is still
// created either way and admin can resend.

export async function sendInviteEmail(
  invitedEmail: string,
  invitedByEmail: string
): Promise<boolean> {
  const fromAddr = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME ?? "Replen";
  const appUrl = dashboardUrl(); // the webapp host (app.replen.dev), not the skill API

  if (!fromAddr) {
    console.warn("[invite] EMAIL_FROM_ADDRESS not set; skipping email send");
    return false;
  }
  const provider = pickEmailProvider();
  if (!provider) {
    console.warn("[invite] no email provider configured; skipping");
    return false;
  }

  const loginUrl = `${appUrl}/login`;
  const subject = `${invitedByEmail} invited you to Replen`;
  const text = `Hi,

${invitedByEmail} added you to Replen: a daily, personalised feed of
open-source projects relevant to whatever you're building.

Sign in here with this email address (${invitedEmail}):
  ${loginUrl}

Once you're in, head to /settings to add your GitHub token and configure
where you'd like the morning research email sent.

- Replen`;

  const html = brandedEmail({
    preheader: `${invitedByEmail} added you to Replen.`,
    bodyHtml: `
  <h1 class="r-fg" style="font-size:22px;letter-spacing:-0.02em;margin:0 0 16px;color:${C.fg}">You're in.</h1>
  <p class="r-fg" style="margin:0 0 16px;color:${C.fg}"><b>${escapeHtml(invitedByEmail)}</b> added you to Replen, the AI that asks "can we do this better?" on your codebase, against the live ecosystem.</p>
  <p style="margin:24px 0;">
    <a href="${escapeHref(loginUrl)}" class="r-btn" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#ffffff;font-weight:600;text-decoration:none;border-radius:6px">Sign in</a>
  </p>
  <p class="r-fg" style="margin:0 0 16px;color:${C.fg}">Use this email address: <code class="r-raised" style="background:${C.raised};padding:2px 6px;border-radius:4px">${escapeHtml(invitedEmail)}</code></p>
  <p class="r-dim" style="margin-top:24px;font-size:13px;color:${C.dim}">After sign-in, visit <a href="${escapeHref(`${appUrl}/settings`)}" class="r-fg" style="color:${C.fg};text-decoration:underline">/settings</a> to add your GitHub token and choose which emails you'd like. Manage your sources (curated + your own additions) on <a href="${escapeHref(`${appUrl}/sources`)}" class="r-fg" style="color:${C.fg};text-decoration:underline">/sources</a>.</p>
  <p class="r-faint" style="font-size:12px;color:${C.faint};margin-top:32px">If you didn't expect this email, just ignore it.</p>`,
    footer: { dashboardUrl: appUrl, prefsUrl: `${appUrl}/settings` },
  });

  const r = await provider.send({
    from: `"${fromName}" <${fromAddr}>`,
    to: invitedEmail,
    subject,
    text,
    html,
  });
  if (!r.ok) {
    console.error(`[invite] failed for ${invitedEmail} via ${provider.name}: ${r.error}`);
    return false;
  }
  console.log(`[invite] sent to ${invitedEmail} via ${provider.name}`);
  return true;
}

