import { db, schema } from "@/db/client";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { formatTimestampToMinute } from "@/lib/format-date";
import { Icon } from "@/components/Icons";

// Skill-mode home view. Shared between / (signed-in user) and /demo
// (seeded snapshot). Both pages resolve their own user, then pass it
// in here. The view is calm:
//   - Hero ("What could you make better today?")
//   - Activity timeline: agent decisions (triage_events) + user
//     actions (user_match_state), merged.

type Event =
  | {
      kind: "user";
      id: number;
      status: string;
      at: Date;
      handoffPrUrl: string | null;
      repoOwner: string;
      repoName: string;
      projectName: string | null;
    }
  | {
      kind: "agent";
      id: number;
      verdict: string;
      at: Date;
      score: number | null;
      effortBand: string | null;
      oneLine: string | null;
      repoOwner: string;
      repoName: string;
      projectName: string | null;
    };

export async function SkillHome({ user, demoMode = false }: {
  user: { id: number; email: string };
  demoMode?: boolean;
}) {
  const events = await fetchRecentEvents(user.id, 50);
  // First-name greeting for signed-in users only. Demo gets neutral.
  const firstName = !demoMode ? guessFirstName(user.email) : null;

  return (
    <div style={pageStyle}>
      <section style={heroStyle}>
        <h1 style={titleStyle}>
          What could you make better today
          <span style={{ color: "var(--amber)" }}>?</span>
        </h1>
        <p style={subtitleStyle}>
          {demoMode ? (
            <>
              This is a seeded snapshot of what your Replen looks like
              after a few weeks of use. Below: a real timeline of
              agent verdicts and user actions on candidates from the
              wider ecosystem. <a href="/login" style={ctaStyle}>
              Sign up to try it on your own repos &rarr;</a>
            </>
          ) : (
            <>
              {firstName ? `Hi ${firstName}. ` : ""}
              Replen watches the wider ecosystem against your projects.
              When something lands that&apos;s worth a look, your agent
              mentions it the next time you open Claude Code.
              Most days are quiet, by design.
            </>
          )}
        </p>
      </section>

      <section style={sectionStyle}>
        <header style={sectionHeadStyle}>
          <h2 style={sectionTitleStyle}>Activity</h2>
          <span style={sectionMetaStyle}>
            {events.length === 0 ? "nothing yet" : `last ${events.length}`}
          </span>
        </header>
        {events.length === 0 ? (
          <EmptyActivity />
        ) : (
          <ol style={timelineStyle}>
            {events.map((e) => (
              <ActivityRow key={e.id} event={e} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

async function fetchRecentEvents(userId: number, limit: number): Promise<Event[]> {
  // Two streams interleaved on the Activity timeline:
  //   1. user_match_state rows where the user took an action (star/hide/handoff)
  //   2. triage_events rows logged by the agent during /replen-match
  // Each stream pulls up to `limit`, we merge + re-sort + truncate.
  const [userRows, agentRows] = await Promise.all([
    db
      .select({
        id: schema.userMatchState.id,
        status: schema.userMatchState.status,
        actionAt: schema.userMatchState.actionAt,
        handoffPrUrl: schema.userMatchState.handoffPrUrl,
        repoId: schema.userMatchState.repoId,
        projectId: schema.userMatchState.projectId,
      })
      .from(schema.userMatchState)
      .where(and(
        eq(schema.userMatchState.userId, userId),
        isNotNull(schema.userMatchState.actionAt),
      ))
      .orderBy(desc(schema.userMatchState.actionAt))
      .limit(limit),
    db
      .select({
        id: schema.triageEvents.id,
        verdict: schema.triageEvents.verdict,
        score: schema.triageEvents.score,
        effortBand: schema.triageEvents.effortBand,
        oneLine: schema.triageEvents.oneLine,
        createdAt: schema.triageEvents.createdAt,
        repoId: schema.triageEvents.repoId,
        projectId: schema.triageEvents.projectId,
      })
      .from(schema.triageEvents)
      .where(eq(schema.triageEvents.userId, userId))
      .orderBy(desc(schema.triageEvents.createdAt))
      .limit(limit),
  ]);

  if (userRows.length === 0 && agentRows.length === 0) return [];

  const repoIds = [
    ...new Set([
      ...userRows.map((r) => r.repoId),
      ...agentRows.map((r) => r.repoId),
    ]),
  ];
  const projectIds = [
    ...new Set([
      ...userRows.map((r) => r.projectId),
      ...agentRows.map((r) => r.projectId),
    ].filter((x): x is number => x !== null)),
  ];

  const repos = repoIds.length
    ? await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds))
    : [];
  const projects = projectIds.length
    ? await db
        .select()
        .from(schema.projectProfiles)
        .where(and(
          eq(schema.projectProfiles.userId, userId),
          inArray(schema.projectProfiles.id, projectIds),
        ))
    : [];

  const repoMap = new Map(repos.map((r) => [r.id, r]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));

  const merged: Event[] = [
    ...userRows.map((r): Event => {
      const repo = repoMap.get(r.repoId);
      const project = r.projectId != null ? projectMap.get(r.projectId) : null;
      return {
        kind: "user",
        id: r.id,
        status: r.status,
        at: r.actionAt!,
        handoffPrUrl: r.handoffPrUrl,
        repoOwner: repo?.owner ?? "?",
        repoName: repo?.name ?? "unknown",
        projectName: project?.slug ?? null,
      };
    }),
    ...agentRows.map((r): Event => {
      const repo = repoMap.get(r.repoId);
      const project = r.projectId != null ? projectMap.get(r.projectId) : null;
      return {
        kind: "agent",
        id: r.id,
        verdict: r.verdict,
        at: r.createdAt,
        score: r.score,
        effortBand: r.effortBand,
        oneLine: r.oneLine,
        repoOwner: repo?.owner ?? "?",
        repoName: repo?.name ?? "unknown",
        projectName: project?.slug ?? null,
      };
    }),
  ];

  merged.sort((a, b) => b.at.getTime() - a.at.getTime());
  return merged.slice(0, limit);
}

function ActivityRow({ event }: { event: Event }) {
  const verb = event.kind === "user" ? verbForUser(event.status) : verbForAgent(event.verdict);
  const key = event.kind === "user" ? event.status : event.verdict;
  return (
    <li style={rowStyle}>
      <span style={markerStyle(event.kind, key)} aria-hidden="true">
        <Icon name={iconFor(event.kind, key)} size={14} />
      </span>
      <div style={rowBodyStyle}>
        <div style={rowMainStyle}>
          <span style={verbStyle(event.kind, key)}>{verb}</span>{" "}
          <a
            href={`https://github.com/${event.repoOwner}/${event.repoName}`}
            target="_blank"
            rel="noreferrer noopener"
            style={repoLinkStyle}
          >
            {event.repoOwner}/{event.repoName}
          </a>
          {event.projectName && (
            <>
              {" "}
              <span style={{ color: "var(--faint)" }}>→</span>{" "}
              <span style={projectChipStyle}>{event.projectName}</span>
            </>
          )}
        </div>
        {event.kind === "agent" && event.oneLine && (
          <div style={oneLineStyle}>{event.oneLine}</div>
        )}
        <div style={rowMetaStyle}>
          <span>{formatRelative(event.at)}</span>
          {event.kind === "agent" && event.score !== null && (
            <>
              <span>·</span>
              <span>score {event.score}</span>
            </>
          )}
          {event.kind === "agent" && event.effortBand && (
            <>
              <span>·</span>
              <span>{event.effortBand}</span>
            </>
          )}
          {event.kind === "user" && event.handoffPrUrl && (
            <>
              <span>·</span>
              <a
                href={event.handoffPrUrl}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: "var(--amber)" }}
              >
                handoff PR
              </a>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function EmptyActivity() {
  return (
    <div style={emptyStyle}>
      <p style={{ margin: 0, color: "var(--fg)" }}>
        Nothing yet.
      </p>
      <p style={{ margin: "8px 0 0", color: "var(--dim)", fontSize: 14, lineHeight: 1.55 }}>
        Open Claude Code in any of your tracked repos. When Replen has
        candidates queued, your agent triages them in-session and lands
        a verdict here for each one — adopt, port, skip, or defer.
        Your own actions (star, hide, hand off) interleave with the
        agent&apos;s. Most days are quiet.
      </p>
    </div>
  );
}

function verbForUser(status: string): string {
  switch (status) {
    case "starred": return "Starred";
    case "hidden": return "Hid";
    case "handed_off": return "Handed off";
    case "surfaced": return "Surfaced";
    default: return status;
  }
}

function verbForAgent(verdict: string): string {
  switch (verdict) {
    case "adopt": return "Agent kept";
    case "port": return "Agent: port";
    case "skip": return "Agent skipped";
    case "defer": return "Agent deferred";
    default: return `Agent: ${verdict}`;
  }
}

function iconFor(kind: "user" | "agent", key: string): string {
  if (kind === "user") {
    switch (key) {
      case "starred": return "star-fill";
      case "hidden": return "x";
      case "handed_off": return "arrow-right";
      default: return "circle";
    }
  }
  switch (key) {
    case "adopt": return "check";
    case "port": return "arrow-right";
    case "skip": return "x";
    case "defer": return "circle";
    default: return "circle";
  }
}

function verbStyle(kind: "user" | "agent", key: string): React.CSSProperties {
  const base: React.CSSProperties = { fontWeight: 500 };
  if (kind === "user") {
    switch (key) {
      case "starred": return { ...base, color: "var(--amber)" };
      case "handed_off": return { ...base, color: "var(--green)" };
      case "hidden": return { ...base, color: "var(--dim)" };
      default: return { ...base, color: "var(--fg)" };
    }
  }
  switch (key) {
    case "adopt": return { ...base, color: "var(--green)" };
    case "port": return { ...base, color: "var(--fg)" };
    case "skip": return { ...base, color: "var(--dim)" };
    case "defer": return { ...base, color: "var(--dim)" };
    default: return { ...base, color: "var(--fg)" };
  }
}

function markerStyle(kind: "user" | "agent", key: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    borderRadius: 12,
    flexShrink: 0,
    marginTop: 2,
  };
  if (kind === "user") {
    switch (key) {
      case "starred":
        return { ...base, background: "var(--amber-soft)", color: "var(--amber)" };
      case "handed_off":
        return { ...base, background: "var(--green-soft)", color: "var(--green)" };
      case "hidden":
        return { ...base, background: "var(--surface-1)", color: "var(--dim)" };
      default:
        return { ...base, background: "var(--surface-1)", color: "var(--fg)" };
    }
  }
  switch (key) {
    case "adopt":
      return { ...base, background: "var(--green-soft)", color: "var(--green)" };
    case "port":
      return { ...base, background: "var(--surface-1)", color: "var(--fg)" };
    default:
      return { ...base, background: "var(--surface-1)", color: "var(--dim)" };
  }
}

function guessFirstName(email: string): string | null {
  const local = email.split("@")[0];
  if (!local) return null;
  const first = local.split(/[._-]/)[0];
  if (!first || first.length < 2 || first.length > 20) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function formatRelative(d: Date): string {
  const now = Date.now();
  const ms = now - d.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatTimestampToMinute(d).replace(/, \d{2}:\d{2}$/, "");
}

const pageStyle: React.CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "32px 24px 80px",
};

const heroStyle: React.CSSProperties = {
  marginBottom: 40,
};

const titleStyle: React.CSSProperties = {
  fontSize: 38,
  fontWeight: 600,
  letterSpacing: -0.5,
  margin: "0 0 14px",
  lineHeight: 1.15,
};

const ctaStyle: React.CSSProperties = {
  color: "var(--amber)",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const subtitleStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--dim)",
  fontSize: 15.5,
  lineHeight: 1.6,
  maxWidth: 620,
};

const sectionStyle: React.CSSProperties = {
  marginTop: 8,
};

const sectionHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  borderBottom: "1px solid var(--surface-2)",
  paddingBottom: 10,
  marginBottom: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: 1.2,
  color: "var(--dim)",
  margin: 0,
};

const sectionMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--faint)",
};

const timelineStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
};

const rowBodyStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const rowMainStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.45,
};

const rowMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--faint)",
  marginTop: 3,
  display: "flex",
  gap: 6,
  alignItems: "center",
};

const repoLinkStyle: React.CSSProperties = {
  color: "var(--fg)",
  textDecoration: "none",
  fontWeight: 500,
};

const projectChipStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--dim)",
  background: "var(--surface-1)",
  padding: "1px 8px",
  borderRadius: 4,
};

const oneLineStyle: React.CSSProperties = {
  fontSize: 13.5,
  color: "var(--dim)",
  lineHeight: 1.5,
  marginTop: 2,
};

const emptyStyle: React.CSSProperties = {
  padding: "24px 22px",
  background: "var(--surface-1)",
  borderRadius: 10,
  border: "1px solid var(--surface-2)",
};
