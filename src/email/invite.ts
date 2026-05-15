import nodemailer from "nodemailer";

// Sends an invite email when an admin adds a new user. The user then visits
// the app, signs in with Firebase using the invited email address, and their
// pre-created placeholder row (firebase_uid: "invited:<email>") is upgraded
// to a real uid on first login (see src/lib/auth/current-user.ts).
//
// Returns true on success. Logs and returns false on failure so the calling
// admin action doesn't crash if SES is misconfigured — the user row is still
// created either way and admin can resend.

export async function sendInviteEmail(
  invitedEmail: string,
  invitedByEmail: string
): Promise<boolean> {
  const host = process.env.SES_SMTP_HOST ?? "email-smtp.eu-west-2.amazonaws.com";
  const port = parseInt(process.env.SES_SMTP_PORT ?? "587", 10);
  const user = process.env.SES_SMTP_USERNAME;
  const pass = process.env.SES_SMTP_PASSWORD;
  const fromAddr = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME ?? "replen";
  const appUrl = process.env.PUBLIC_BASE_URL ?? process.env.APP_PUBLIC_URL ?? "http://localhost:3030";

  if (!user || !pass || !fromAddr) {
    console.warn("[invite] missing SES creds; skipping email send");
    return false;
  }

  const loginUrl = `${appUrl}/login`;
  const subject = `${invitedByEmail} invited you to OSS Digest`;
  const text = `Hi,

${invitedByEmail} added you to OSS Digest — a daily, personalised feed of
open-source projects relevant to whatever you're building.

Sign in here with this email address (${invitedEmail}):
  ${loginUrl}

Once you're in, head to /settings to add your GitHub token and configure
where you'd like the daily digest emailed.

— OSS Digest`;

  const html = `<!doctype html>
<html><body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 560px; margin: 24px auto; padding: 0 16px; color: #222; line-height: 1.55;">
  <h1 style="font-size: 22px; letter-spacing: -0.02em; margin: 0 0 16px;">You're in.</h1>
  <p><b>${escapeHtml(invitedByEmail)}</b> added you to OSS Digest — a daily, personalised feed of open-source projects relevant to whatever you're building.</p>
  <p style="margin: 24px 0;">
    <a href="${loginUrl}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">Sign in</a>
  </p>
  <p>Use this email address: <code>${escapeHtml(invitedEmail)}</code></p>
  <p style="margin-top: 24px; font-size: 13px; color: #888;">After sign-in, visit <a href="${appUrl}/settings">/settings</a> to add your GitHub token and configure where the daily digest emails should arrive. Manage your sources (curated + your own additions) on <a href="${appUrl}/sources">/sources</a>.</p>
  <p style="font-size: 12px; color: #888; margin-top: 32px;">If you didn't expect this email, just ignore it.</p>
</body></html>`;

  try {
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transport.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to: invitedEmail,
      subject,
      text,
      html,
    });
    console.log(`[invite] sent to ${invitedEmail}`);
    return true;
  } catch (e) {
    console.error(`[invite] failed for ${invitedEmail}:`, (e as any)?.message ?? e);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
