// Email provider abstraction. The product is provider-agnostic; pick one of
// these adapters via `EMAIL_PROVIDER` env var:
//
//   EMAIL_PROVIDER=ses     (default) - any SMTP server, configured with SES_SMTP_*
//   EMAIL_PROVIDER=resend             - Resend's REST API, configured with RESEND_API_KEY
//   EMAIL_PROVIDER=smtp               - alias for ses; any generic SMTP host/port/creds
//
// Add more by implementing the EmailMessage contract and wiring into pickProvider.

import nodemailer from "nodemailer";

export type EmailMessage = {
  from: string;       // formatted "Name <addr@example.com>" or bare "addr@example.com"
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface EmailProvider {
  name: string;
  send(msg: EmailMessage): Promise<{ ok: true } | { ok: false; error: string }>;
}

// ── SMTP / SES adapter ────────────────────────────────────────

class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  constructor(
    private host: string,
    private port: number,
    private user: string,
    private pass: string,
  ) {}

  async send(msg: EmailMessage): Promise<{ ok: true } | { ok: false; error: string }> {
    const transport = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.port === 465,
      auth: { user: this.user, pass: this.pass },
    });
    try {
      await transport.sendMail(msg);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

// ── Resend adapter ────────────────────────────────────────────

class ResendProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private apiKey: string) {}

  async send(msg: EmailMessage): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: msg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

// ── Provider picker ───────────────────────────────────────────

export function pickEmailProvider(): EmailProvider | null {
  const kind = (process.env.EMAIL_PROVIDER ?? "ses").toLowerCase();

  if (kind === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("[email] EMAIL_PROVIDER=resend but RESEND_API_KEY is not set; cannot send.");
      return null;
    }
    return new ResendProvider(apiKey);
  }

  // Default: SMTP/SES. The legacy SES_SMTP_* env vars are the primary names;
  // SMTP_* aliases are accepted so non-AWS deployments don't have to use
  // misleading variable names.
  const host = process.env.SES_SMTP_HOST ?? process.env.SMTP_HOST ?? "email-smtp.eu-west-2.amazonaws.com";
  const port = parseInt(process.env.SES_SMTP_PORT ?? process.env.SMTP_PORT ?? "587", 10);
  const user = process.env.SES_SMTP_USERNAME ?? process.env.SMTP_USERNAME;
  const pass = process.env.SES_SMTP_PASSWORD ?? process.env.SMTP_PASSWORD;
  if (!user || !pass) {
    console.warn("[email] EMAIL_PROVIDER=ses/smtp but credentials are missing; cannot send.");
    return null;
  }
  return new SmtpProvider(host, port, user, pass);
}
