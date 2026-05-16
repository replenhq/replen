import { pickEmailProvider } from "./providers";
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
  const appUrl = process.env.PUBLIC_BASE_URL ?? process.env.APP_PUBLIC_URL ?? "http://localhost:3030";

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

  const html = `<!doctype html>
<html><body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 560px; margin: 24px auto; padding: 0 16px; color: #222; line-height: 1.55;">
  <h1 style="font-size: 22px; letter-spacing: -0.02em; margin: 0 0 16px;">You're in.</h1>
  <p><b>${escapeHtml(invitedByEmail)}</b> added you to Replen, the AI that asks "can we do this better?" on your codebase, every morning, against the live ecosystem.</p>
  <p style="margin: 24px 0;">
    <a href="${escapeHref(loginUrl)}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">Sign in</a>
  </p>
  <p>Use this email address: <code>${escapeHtml(invitedEmail)}</code></p>
  <p style="margin-top: 24px; font-size: 13px; color: #888;">After sign-in, visit <a href="${escapeHref(`${appUrl}/settings`)}">/settings</a> to add your GitHub token and configure where the morning research email should arrive. Manage your sources (curated + your own additions) on <a href="${escapeHref(`${appUrl}/sources`)}">/sources</a>.</p>
  <p style="font-size: 12px; color: #888; margin-top: 32px;">If you didn't expect this email, just ignore it.</p>
</body></html>`;

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

