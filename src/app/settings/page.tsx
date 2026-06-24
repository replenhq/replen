import { requireUser } from "@/lib/auth/current-user";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { formatTimestampToMinute } from "@/lib/format-date";

export const dynamic = "force-dynamic";

// Skill-mode settings: account housekeeping only. The hosted-tier
// LLM provider / GitHub PAT / matching mode / sensitive projects /
// daily cost cap surfaces all moved to _legacy/settings-full.tsx
// (non-routable). Re-introduce by routing the file back if we ever
// flip a user to hosted-tier.

export default async function Settings({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;

  // Show when the user was created + last visited so they know what
  // we have on them. No-op for accounts with missing timestamps.
  const account = await db
    .select({
      email: schema.users.email,
      createdAt: schema.users.createdAt,
      lastViewedAt: schema.users.lastViewedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .get();

  // Email preferences (powers the digest / weekly brief / security alerts).
  const settings = await db
    .select({
      emailToAddress: schema.userSettings.emailToAddress,
      enabled: schema.userSettings.enabled,
      weeklyBriefEnabled: schema.userSettings.weeklyBriefEnabled,
      briefFrequency: schema.userSettings.briefFrequency,
      digestEnabled: schema.userSettings.digestEnabled,
      securityAlertsEnabled: schema.userSettings.securityAlertsEnabled,
    })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, user.id))
    .get();
  const briefSel = settings?.weeklyBriefEnabled === false ? "off" : (settings?.briefFrequency ?? "weekly");

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Settings</h1>
      </header>

      {sp.saved && <div style={flashOkStyle}>Preferences saved.</div>}
      {sp.error === "email" && (
        <div style={flashErrStyle}>That doesn&apos;t look like a valid email address — preferences not saved.</div>
      )}

      <section style={cardStyle}>
        <Row label="Email">
          <span style={valueStyle}>{account?.email ?? user.email}</span>
        </Row>
        {account?.createdAt && (
          <Row label="Joined">
            <span style={valueStyle}>
              {formatTimestampToMinute(account.createdAt)}
            </span>
          </Row>
        )}
        {account?.lastViewedAt && (
          <Row label="Last visit">
            <span style={valueStyle}>
              {formatTimestampToMinute(account.lastViewedAt)}
            </span>
          </Row>
        )}
      </section>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Email preferences</h2>
        <form action="/api/settings/email" method="post">
          <Row label="Sends to">
            <span style={valueStyle}>{account?.email ?? user.email}</span>
          </Row>
          <Row label="Brief">
            <select name="briefFrequency" defaultValue={briefSel} style={inputStyle}>
              <option value="weekly">Weekly</option>
              <option value="twiceweekly">Twice a week</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="monthly">Monthly</option>
              <option value="off">Off</option>
            </select>
          </Row>
          <Row label="Matches digest">
            <label style={checkLabelStyle}>
              <input type="checkbox" name="digestEnabled" defaultChecked={settings?.digestEnabled ?? true} /> New tools
              matched to your repos
            </label>
          </Row>
          <Row label="Security alerts">
            <label style={checkLabelStyle}>
              <input type="checkbox" name="securityAlertsEnabled" defaultChecked={settings?.securityAlertsEnabled ?? true} />{" "}
              Critical advisories that hit your stack
            </label>
          </Row>
          <Row label="All email">
            <label style={checkLabelStyle}>
              <input type="checkbox" name="enabled" defaultChecked={settings?.enabled ?? true} /> Master switch — uncheck to
              pause everything
            </label>
          </Row>
          <div style={{ textAlign: "right", paddingTop: 14 }}>
            <button type="submit" style={saveBtnStyle}>
              Save preferences
            </button>
          </div>
        </form>
      </section>

      <section style={cardStyle}>
        <Row label="Sign out">
          <a href="/api/logout" style={linkStyle}>
            Sign out of this browser
          </a>
        </Row>
      </section>

      <section style={dangerCardStyle}>
        <h2 style={dangerTitleStyle}>Danger zone</h2>
        <p style={dangerCopyStyle}>
          Deleting your account removes your registered projects and
          match history from Replen. Your local repos, CLAUDE.md / AGENTS.md
          files, and the <code style={codeStyle}>/replen-match</code> skill
          in <code style={codeStyle}>~/.claude/skills/</code> are not touched
          — you can remove those manually if you want a clean slate.
        </p>
        <form action="/api/account/delete" method="post">
          <button type="submit" style={dangerBtnStyle}>
            Delete my account
          </button>
        </form>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={{ flex: 1, textAlign: "right" }}>{children}</span>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 640,
  margin: "0 auto",
  padding: "32px 24px 80px",
};

const headerStyle: React.CSSProperties = {
  marginBottom: 28,
};

const titleStyle: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 600,
  margin: 0,
  letterSpacing: -0.3,
};

const cardStyle: React.CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--surface-2)",
  borderRadius: 10,
  padding: "4px 18px",
  marginBottom: 18,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "14px 0",
  borderBottom: "1px solid var(--surface-2)",
  fontSize: 14,
};

const labelStyle: React.CSSProperties = {
  color: "var(--dim)",
  flexShrink: 0,
  minWidth: 110,
};

const valueStyle: React.CSSProperties = {
  color: "var(--fg)",
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
};

const linkStyle: React.CSSProperties = {
  color: "var(--amber)",
  textDecoration: "none",
};

const dangerCardStyle: React.CSSProperties = {
  marginTop: 32,
  padding: "20px 22px",
  border: "1px solid rgba(255, 99, 99, 0.25)",
  background: "rgba(255, 99, 99, 0.04)",
  borderRadius: 10,
};

const dangerTitleStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  fontWeight: 500,
  color: "#ff8b7a",
  textTransform: "uppercase",
  letterSpacing: 1.1,
};

const dangerCopyStyle: React.CSSProperties = {
  margin: "0 0 16px",
  color: "var(--dim)",
  fontSize: 14,
  lineHeight: 1.55,
};

const dangerBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#ff8b7a",
  border: "1px solid rgba(255, 99, 99, 0.4)",
  padding: "8px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};

const codeStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  padding: "1px 5px",
  borderRadius: 3,
  fontFamily: "ui-monospace, monospace",
  fontSize: 12.5,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: "10px 0 2px",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--dim)",
  textTransform: "uppercase",
  letterSpacing: 1.1,
};

const inputStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--surface-2)",
  borderRadius: 6,
  padding: "6px 10px",
  color: "var(--fg)",
  fontSize: 13,
  minWidth: 200,
};

const checkLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  color: "var(--fg)",
  fontSize: 13,
  cursor: "pointer",
};

const saveBtnStyle: React.CSSProperties = {
  background: "var(--amber)",
  color: "#1a1a1a",
  border: "none",
  padding: "8px 16px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};

const flashOkStyle: React.CSSProperties = {
  margin: "0 0 18px",
  padding: "10px 14px",
  borderRadius: 8,
  background: "rgba(31, 138, 76, 0.12)",
  border: "1px solid rgba(31, 138, 76, 0.35)",
  color: "#3ec77e",
  fontSize: 13,
};

const flashErrStyle: React.CSSProperties = {
  margin: "0 0 18px",
  padding: "10px 14px",
  borderRadius: 8,
  background: "rgba(255, 99, 99, 0.08)",
  border: "1px solid rgba(255, 99, 99, 0.3)",
  color: "#ff8b7a",
  fontSize: 13,
};
