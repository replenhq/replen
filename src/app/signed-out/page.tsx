// Public page shown after /api/logout. Confirms the sign-out, surfaces
// the brand, and gives the user a one-click path back in. No auth gate
// — must render to an anonymous visitor since their session cookies
// were just cleared.

export const dynamic = "force-dynamic";

export default function SignedOutPage() {
  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <div style={{ marginBottom: 24, display: "flex", justifyContent: "center" }}>
          {/* Inline SVG so the page renders even if /logo.svg fails. */}
          <svg width="64" height="42" viewBox="0 0 200 130" aria-hidden="true">
            <defs>
              <mask id="signedout-mask">
                <rect width="200" height="130" fill="#fff"/>
                <path fill="#000" d="M 36 36 H 164 a 7 7 0 0 1 7 7 V 87 a 5 5 0 0 1 -5 5 H 122 c -3 0 -5 1 -7 4 c -3 5 -8 8 -15 8 c -7 0 -12 -3 -15 -8 c -2 -3 -4 -4 -7 -4 H 34 a 5 5 0 0 1 -5 -5 V 43 a 7 7 0 0 1 7 -7 Z"/>
              </mask>
            </defs>
            <g fill="currentColor" mask="url(#signedout-mask)">
              <rect x="40" y="4" width="120" height="24" rx="11"/>
              <rect x="40" y="102" width="120" height="24" rx="11"/>
              <rect x="0" y="42" width="26" height="46" rx="12"/>
              <rect x="174" y="42" width="26" height="46" rx="12"/>
              <rect x="20" y="20" width="160" height="90" rx="13"/>
            </g>
            <g fill="currentColor">
              <rect x="48" y="48" width="20" height="6" rx="3"/>
              <rect x="76" y="48" width="76" height="6" rx="3"/>
            </g>
          </svg>
        </div>

        <h1 style={titleStyle}>You&rsquo;re signed out</h1>
        <p style={leadStyle}>
          Your session has been cleared from this browser. Sign back in any time &mdash; your matches, starred repos, and project profiles all stay exactly where they were.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 28 }}>
          <a href="/login" style={primaryBtnStyle}>
            Sign back in &rarr;
          </a>
          <a href="/demo" style={secondaryBtnStyle}>
            Or try the demo
          </a>
        </div>

        <p style={footerStyle}>
          <a href="https://replen.dev" style={footerLinkStyle}>replen.dev</a>
          {" "}&middot;{" "}
          <a href="https://docs.replen.dev" style={footerLinkStyle}>docs</a>
          {" "}&middot;{" "}
          <a href="https://github.com/replenhq/replen" style={footerLinkStyle}>github</a>
        </p>
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  textAlign: "center",
  padding: "40px 32px",
  background: "var(--surface-1, transparent)",
  border: "1px solid var(--line, rgba(255,255,255,0.07))",
  borderRadius: 16,
  color: "var(--fg, #ece9e2)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  margin: "0 0 12px",
  color: "var(--fg, #ece9e2)",
};

const leadStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: "var(--dim, #9d9a93)",
  margin: 0,
};

const primaryBtnStyle: React.CSSProperties = {
  display: "block",
  padding: "12px 20px",
  background: "var(--amber, #ffc857)",
  color: "#1a1a1a",
  textDecoration: "none",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 15,
};

const secondaryBtnStyle: React.CSSProperties = {
  display: "block",
  padding: "10px 20px",
  background: "transparent",
  color: "var(--fg, #ece9e2)",
  textDecoration: "none",
  border: "1px solid var(--line-strong, rgba(255,255,255,0.13))",
  borderRadius: 8,
  fontWeight: 500,
  fontSize: 14,
};

const footerStyle: React.CSSProperties = {
  marginTop: 32,
  fontSize: 12,
  color: "var(--faint, #66645e)",
};

const footerLinkStyle: React.CSSProperties = {
  color: "var(--faint, #66645e)",
  textDecoration: "none",
};
