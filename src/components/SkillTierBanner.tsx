import { db, schema } from "@/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";

// Skill-mode tier banner. Renders at the top of /, /starred,
// /integrated, /runs to:
//   1. Explain the new model to a user landing on the webapp
//      ("matching runs in your CLI now").
//   2. Show a compact summary of their actual state — counts pulled
//      from user_match_state, the canonical store for skill-tier
//      outcomes.
//   3. Point at /replen-match as the actionable next step.
//
// Returns null for hosted-tier users (so the legacy pages render
// unchanged for them).
//
// Server component — runs synchronously against the DB on each page
// render. The query is one bucketed count per status (~3 rows total
// for any user) so it's effectively free.
export async function SkillTierBanner({ userId, subscriptionTier }: {
  userId: number;
  subscriptionTier: string;
}) {
  if (subscriptionTier !== "skill") return null;

  // Bucketed counts of user_match_state rows by status. INDEX
  // idx_user_match_state_user_status makes this an index-only scan.
  const counts = await db
    .select({
      status: schema.userMatchState.status,
      n: sql<number>`count(*)`.as("n"),
    })
    .from(schema.userMatchState)
    .where(eq(schema.userMatchState.userId, userId))
    .groupBy(schema.userMatchState.status);

  const byStatus = new Map<string, number>(counts.map((c) => [c.status, Number(c.n)]));
  const starred = byStatus.get("starred") ?? 0;
  const handedOff = byStatus.get("handed_off") ?? 0;
  const hidden = byStatus.get("hidden") ?? 0;
  const total = starred + handedOff + hidden;

  return (
    <section style={{
      maxWidth: 720,
      margin: "16px 0 0",
      padding: "14px 18px",
      border: "1px solid rgba(0, 100, 200, 0.18)",
      borderRadius: 10,
      background: "rgba(0, 100, 200, 0.04)",
      fontSize: 14,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Skill mode</div>
          <div style={{ color: "rgba(0,0,0,0.7)", lineHeight: 1.5 }}>
            Matching now runs in your CLI on your subscription tokens, not on Replen's hosted scorer.
            Open Claude Code in a tracked repo and run <code style={codeStyle}>/replen-match</code> (or
            <code style={codeStyle}>use replen_match</code> on any MCP host). This page is your action history.
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, flexShrink: 0, alignItems: "center" }}>
          <Stat n={starred} label="starred" href="/starred" />
          <Stat n={handedOff} label="handed off" href="/integrated" />
          <Stat n={hidden} label="hidden" />
        </div>
      </div>
      {total === 0 && (
        <div style={{ marginTop: 10, color: "rgba(0,0,0,0.55)", fontSize: 13 }}>
          No matches actioned yet. Run <code style={codeStyle}>/replen-match</code> when you next open Claude Code.
        </div>
      )}
    </section>
  );
}

const codeStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.06)",
  padding: "1px 5px",
  borderRadius: 3,
  fontFamily: "ui-monospace, monospace",
  fontSize: 12.5,
};

function Stat({ n, label, href }: { n: number; label: string; href?: string }) {
  const body = (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2 }}>
      <span style={{ fontWeight: 600, fontSize: 18 }}>{n}</span>
      <span style={{ fontSize: 11, color: "rgba(0,0,0,0.55)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
    </span>
  );
  return href && n > 0
    ? <a href={href} style={{ textDecoration: "none", color: "inherit" }}>{body}</a>
    : body;
}

// Helper for pages to fetch the tier once and pass it through. Avoids
// every page making the same user_settings select.
export async function fetchSubscriptionTier(userId: number): Promise<string> {
  const row = await db
    .select({ subscriptionTier: schema.userSettings.subscriptionTier })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  return row?.subscriptionTier ?? "skill";
}

// Skill-tier query for /starred and /integrated. Returns user_match_state
// rows joined with repos + projects so the page can render a flat table
// without each row doing its own joins. Status filter passed by the caller.
export async function fetchSkillState(userId: number, statuses: string[]) {
  const rows = await db
    .select()
    .from(schema.userMatchState)
    .where(and(
      eq(schema.userMatchState.userId, userId),
      inArray(schema.userMatchState.status, statuses),
    ));
  if (rows.length === 0) return { rows: [], repoMap: new Map(), projectMap: new Map() };

  const repoIds = [...new Set(rows.map((r) => r.repoId))];
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is number => !!x))];
  const repoMap = new Map<number, typeof schema.repos.$inferSelect>();
  const projectMap = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (repoIds.length > 0) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repoMap.set(r.id, r);
  }
  if (projectIds.length > 0) {
    const ps = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, userId),
        inArray(schema.projectProfiles.id, projectIds),
      ));
    for (const p of ps) projectMap.set(p.id, p);
  }
  return { rows, repoMap, projectMap };
}
