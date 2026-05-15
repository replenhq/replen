import { requireUser } from "@/lib/auth/current-user";
import { CliAuthForm } from "./CliAuthForm";

export const dynamic = "force-dynamic";

// Browser-callback auth flow for the `replen` CLI. The CLI opens this page
// with ?port=NNNN&state=HEX, the user signs in (if needed) and clicks
// Authorize. The button triggers a server action that mints/fetches the
// user's ingest token, then the client navigates to
// http://127.0.0.1:<port>/callback so the CLI process (listening on that
// port) can grab it. Same shape as `gh auth login --web`.

type Params = {
  searchParams: Promise<{ port?: string; state?: string }>;
};

function validatePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n < 1024 || n > 65535) return null;
  return n;
}

function validateState(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!/^[a-f0-9]{32,128}$/i.test(raw)) return null;
  return raw;
}

export default async function CliAuthPage({ searchParams }: Params) {
  const sp = await searchParams;
  const port = validatePort(sp.port);
  const state = validateState(sp.state);

  if (!port || !state) {
    return (
      <main style={pageStyle}>
        <h1 style={h1Style}>Bad request</h1>
        <p style={dimStyle}>
          This page needs to be opened by the <code>replen</code> CLI. Run{" "}
          <code>npx replen</code> from your terminal — it'll open the right
          link for you.
        </p>
      </main>
    );
  }

  // Hits auth gate. If not logged in, middleware bounces to /login and
  // brings the user back here after sign-in / sign-up.
  const user = await requireUser();

  return (
    <main style={pageStyle}>
      <h1 style={h1Style}>Authorize the replen CLI</h1>
      <p style={dimStyle}>
        An app running on your computer (<code>localhost:{port}</code>) is
        asking to connect to your replen account.
      </p>

      <div style={cardStyle}>
        <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>Signed in as</div>
        <div style={{ fontWeight: 600, marginBottom: 16 }}>{user.email}</div>

        <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>The CLI will receive</div>
        <ul style={ulStyle}>
          <li>Your ingest token — read/write access to matches, settings, handoffs</li>
          <li>Your dashboard URL — to wire into Claude Code / Codex config</li>
        </ul>

        <CliAuthForm port={port} state={state} />

        <p style={{ fontSize: 12, color: "#888", marginTop: 16 }}>
          You can revoke this at any time on the{" "}
          <a href="/settings" style={{ color: "#06f" }}>Settings</a> page — rotating the ingest
          token stops the old one working immediately.
        </p>
      </div>

      <p style={{ fontSize: 12, color: "#888", marginTop: 24 }}>
        Not expecting this? Just close this tab. Nothing happens until you click Authorize.
      </p>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 540,
  margin: "60px auto",
  padding: "0 24px",
  fontFamily: "system-ui, -apple-system, sans-serif",
  color: "#111",
};
const h1Style: React.CSSProperties = { fontSize: 24, margin: "0 0 12px", letterSpacing: "-0.01em" };
const dimStyle: React.CSSProperties = { color: "#555", fontSize: 15, lineHeight: 1.55, margin: "0 0 24px" };
const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e5e5",
  borderRadius: 10,
  padding: 20,
  background: "#fafafa",
};
const ulStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#222",
  lineHeight: 1.7,
  paddingLeft: 18,
  margin: "0 0 16px",
};
