import { db, schema } from "@/db/client";
import { desc, eq, and, inArray, isNotNull, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { formatTimestampToMinute } from "@/lib/format-date";
import { createHandoff, refreshHandoffStatuses, setMatchStatus } from "../actions";
import { BulkBar, RowCheck } from "./BulkBar";
import { SkillTierBanner, fetchSubscriptionTier, fetchSkillState } from "@/components/SkillTierBanner";

export const dynamic = "force-dynamic";

// Two flavours on this page:
//   - "Starred" = action items the user wants to ship. high/medium relevance,
//     userStatus='starred'. Bucketed by handoff lifecycle.
//   - "Bookmarks" = save-for-laters. general-awareness relevance, userStatus
//     ='bookmarked'. Re-evaluated against the user's other projects every 20
//     days (see docs/bookmark-resurface-scope.md). The bookmark section shows
//     the resurface state per bookmark — when it was last checked, when the
//     next retry falls, and whether it surfaced as a fit for any project.
const RESURFACE_RETRY_DAYS = 20;

export default async function Starred() {
  const user = await requireUser();

  const saved = await db
    .select()
    .from(schema.matches)
    .where(and(
      eq(schema.matches.userId, user.id),
      inArray(schema.matches.userStatus, ["starred", "bookmarked"]),
    ))
    .orderBy(desc(schema.matches.createdAt));

  const starred = saved.filter((m) => m.userStatus === "starred");
  const bookmarks = saved.filter((m) => m.userStatus === "bookmarked");

  const repoIds = [...new Set(saved.map((m) => m.repoId))];
  const projectIds = [...new Set(saved.map((m) => m.projectId).filter((x): x is number => !!x))];
  const repoMap = new Map<number, typeof schema.repos.$inferSelect>();
  if (repoIds.length > 0) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repoMap.set(r.id, r);
  }
  const projectMap = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (projectIds.length > 0) {
    const ps = await db.select().from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, user.id),
        inArray(schema.projectProfiles.id, projectIds),
      ));
    for (const p of ps) projectMap.set(p.id, p);
  }

  // Resurface state for each bookmark: attempts per repoId, plus any
  // successful resurface matches that came from this bookmark.
  const bookmarkRepoIds = [...new Set(bookmarks.map((b) => b.repoId))];
  const attemptsByRepo = new Map<number, { attemptedAt: Date; outcome: string; projectId: number }[]>();
  if (bookmarkRepoIds.length > 0) {
    const rows = await db
      .select()
      .from(schema.resurfaceAttempts)
      .where(and(
        eq(schema.resurfaceAttempts.userId, user.id),
        inArray(schema.resurfaceAttempts.repoId, bookmarkRepoIds),
      ));
    for (const r of rows) {
      const arr = attemptsByRepo.get(r.repoId) ?? [];
      arr.push({ attemptedAt: r.attemptedAt, outcome: r.outcome, projectId: r.projectId });
      attemptsByRepo.set(r.repoId, arr);
    }
  }
  // Resurfaced matches that descend from these bookmarks (so we can link out).
  const bookmarkIds = bookmarks.map((b) => b.id);
  const resurfaceMatchesByBookmarkId = new Map<number, { matchId: number; projectId: number | null }[]>();
  if (bookmarkIds.length > 0) {
    const rs = await db
      .select({
        id: schema.matches.id,
        resurfacedFromMatchId: schema.matches.resurfacedFromMatchId,
        projectId: schema.matches.projectId,
      })
      .from(schema.matches)
      .where(and(
        eq(schema.matches.userId, user.id),
        eq(schema.matches.discoveryMode, "re-checked"),
        inArray(schema.matches.resurfacedFromMatchId, bookmarkIds),
      ));
    for (const r of rs) {
      if (!r.resurfacedFromMatchId) continue;
      const arr = resurfaceMatchesByBookmarkId.get(r.resurfacedFromMatchId) ?? [];
      arr.push({ matchId: r.id, projectId: r.projectId });
      resurfaceMatchesByBookmarkId.set(r.resurfacedFromMatchId, arr);
    }
    // Also need the project slugs for any resurface-target project that
    // wasn't already in the projectMap (e.g. the resurface matched to a
    // project that has no bookmark in the saved list).
    const extraIds = [...new Set([...resurfaceMatchesByBookmarkId.values()]
      .flatMap((arr) => arr.map((x) => x.projectId)).filter((x): x is number => !!x && !projectMap.has(x)))];
    if (extraIds.length > 0) {
      const ps = await db.select().from(schema.projectProfiles)
        .where(and(
          eq(schema.projectProfiles.userId, user.id),
          inArray(schema.projectProfiles.id, extraIds),
        ));
      for (const p of ps) projectMap.set(p.id, p);
    }
  }

  const awaiting = starred.filter((m) => !m.handoffPrUrl);
  const openPr = starred.filter((m) => m.handoffPrUrl && !m.integratedAt && m.handoffPrStatus !== "merged");
  const integrated = starred.filter((m) => m.integratedAt || m.handoffPrStatus === "merged");
  const isEmpty = starred.length === 0 && bookmarks.length === 0;

  // When was the most recent PR poll? This is the timestamp the "Last refresh"
  // label shows next to the refresh button — useful so the user can tell at a
  // glance how fresh the displayed PR state is. Pulled across all matches with
  // a handoff PR (the only rows the refresh action touches).
  const lastRefreshRow = await db
    .select({ at: sql<number>`MAX(${schema.matches.handoffPrCheckedAt})` })
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, user.id), isNotNull(schema.matches.handoffPrUrl)))
    .get();
  const lastRefreshAt = lastRefreshRow?.at ? new Date(Number(lastRefreshRow.at) * 1000) : null;

  async function refresh() {
    "use server";
    await refreshHandoffStatuses();
  }

  const subscriptionTier = await fetchSubscriptionTier(user.id);
  const skillStarred = subscriptionTier === "skill" ? await fetchSkillState(user.id, ["starred"]) : null;

  return (
    <>
      <SkillTierBanner userId={user.id} subscriptionTier={subscriptionTier} />
      <h1>⭐ Starred &amp; 🔖 Bookmarks</h1>
      {skillStarred && skillStarred.rows.length > 0 && (
        <section style={{ margin: "12px 0 20px", padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-1)" }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>From skill-mode sessions</h2>
          <table style={{ width: "100%", fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: "left" }}>Repo</th><th style={{ textAlign: "left" }}>Project</th><th style={{ textAlign: "left" }}>Note</th><th style={{ textAlign: "right" }}>Starred</th></tr></thead>
            <tbody>
              {skillStarred.rows.map((row) => {
                const r = skillStarred.repoMap.get(row.repoId);
                const p = row.projectId ? skillStarred.projectMap.get(row.projectId) : null;
                return (
                  <tr key={row.id}>
                    <td><a href={r?.url ?? "#"} target="_blank" rel="noopener noreferrer">{r ? `${r.owner}/${r.name}` : `repo#${row.repoId}`}</a></td>
                    <td>{p?.slug ?? "—"}</td>
                    <td style={{ color: "var(--dim)" }}>{row.userNote ?? ""}</td>
                    <td style={{ textAlign: "right", color: "var(--faint)" }}>{formatTimestampToMinute(row.actionAt ?? row.surfacedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {!isEmpty && (
        <p className="meta">
          {starred.length} starred · {awaiting.length} awaiting handoff · {openPr.length} PR open · {integrated.length} integrated · {bookmarks.length} bookmarked
        </p>
      )}
      {isEmpty && (!skillStarred || skillStarred.rows.length === 0) && (
        <div style={{
          border: "1px solid var(--line)",
          borderRadius: 10,
          background: "var(--surface-1)",
          padding: "32px 28px",
          marginTop: 16,
          textAlign: "center",
        }}>
          <div style={{ fontSize: 15, color: "var(--fg)", marginBottom: 8, fontWeight: 500 }}>Nothing starred or bookmarked yet</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--dim)", maxWidth: 480, margin: "0 auto" }}>
            When you triage matches in a session and <b style={{ color: "var(--fg)" }}>star</b> the ones worth shipping
            or <b style={{ color: "var(--fg)" }}>bookmark</b> ones to revisit, they show up here — starred items track
            their handoff-PR status, and bookmarks get re-checked against your projects automatically.
          </div>
        </div>
      )}
      {(openPr.length > 0 || awaiting.length > 0) && (
        <form action={refresh} style={{ margin: "8px 0 16px" }}>
          <button type="submit">↻ Refresh PR statuses</button>
          <span className="meta" style={{ marginLeft: 8 }}>polls open handoff PRs (last checked &gt; 30m ago)</span>
          <div className="meta" style={{ marginTop: 4, fontSize: 12 }}>
            {lastRefreshAt
              ? `Last refresh: ${formatTimestampToMinute(lastRefreshAt)}`
              : "Last refresh: never"}
          </div>
        </form>
      )}

      <BulkBar />

      <Section title={`Awaiting handoff (${awaiting.length})`} list={awaiting} repoMap={repoMap} projectMap={projectMap} bucket="awaiting" />
      <Section title={`PR open (${openPr.length})`} list={openPr} repoMap={repoMap} projectMap={projectMap} bucket="open" />
      <Section title={`Integrated (${integrated.length})`} list={integrated} repoMap={repoMap} projectMap={projectMap} bucket="integrated" />

      <BookmarksSection
        list={bookmarks}
        repoMap={repoMap}
        projectMap={projectMap}
        attemptsByRepo={attemptsByRepo}
        resurfaceMatchesByBookmarkId={resurfaceMatchesByBookmarkId}
      />
    </>
  );
}

function Section({ title, list, repoMap, projectMap, bucket }: {
  title: string;
  list: (typeof schema.matches.$inferSelect)[];
  repoMap: Map<number, typeof schema.repos.$inferSelect>;
  projectMap: Map<number, typeof schema.projectProfiles.$inferSelect>;
  bucket: "awaiting" | "open" | "integrated";
}) {
  if (list.length === 0) return null;
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ borderBottom: "1px solid var(--line)", paddingBottom: 4, marginBottom: 8 }}>{title}</h2>
      {list.map((m) => {
        const repo = repoMap.get(m.repoId);
        if (!repo) return null;
        const project = m.projectId ? projectMap.get(m.projectId) : null;
        const writeup = (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
        return (
          <div className="match" key={m.id}>
            <div className="match-head">
              <RowCheck id={m.id} />
              <a className="repo" href={repo.url} target="_blank" rel="noreferrer">{repo.owner}/{repo.name}</a>
              <span className={`tag ${m.relevance}`}>{m.relevance} {m.relevanceScore ?? ""}</span>
              <span className="meta">
                {project ? <>→ <a href={`/?project=${project.slug}`}>{project.slug}</a> · </> : "_general · "}
                {repo.stars ?? 0}★ · {repo.primaryLanguage ?? "?"}
              </span>
              <form className="inline" action={async () => { "use server"; await setMatchStatus(m.id, "unread"); }}>
                <button title="Unstar">★ remove</button>
              </form>
              {bucket === "awaiting" && project?.githubFullName && (
                <form className="inline" action={async () => { "use server"; await createHandoff(m.id); }}>
                  <button>→ handoff PR</button>
                </form>
              )}
              {bucket === "awaiting" && !project?.githubFullName && (
                <span className="meta" style={{ color: "var(--amber)" }}>
                  {project ? <>(set <code>github_full_name</code> on <a href="/projects">/projects</a>)</> : "_general · no project repo"}
                </span>
              )}
              {m.handoffPrUrl && (
                <a href={m.handoffPrUrl} target="_blank" rel="noreferrer" className="tag" style={{
                  background: m.handoffPrStatus === "merged" ? "#a4d8a4" : m.handoffPrStatus === "closed" ? "#ddd" : "#f5d76e",
                  color: "#1a1a1a", textDecoration: "none",
                }}>
                  ↗ PR{m.handoffPrStatus ? ` · ${m.handoffPrStatus}` : ""}
                </a>
              )}
            </div>
            <div className="writeup">{writeup}</div>
          </div>
        );
      })}
    </section>
  );
}

function BookmarksSection({ list, repoMap, projectMap, attemptsByRepo, resurfaceMatchesByBookmarkId }: {
  list: (typeof schema.matches.$inferSelect)[];
  repoMap: Map<number, typeof schema.repos.$inferSelect>;
  projectMap: Map<number, typeof schema.projectProfiles.$inferSelect>;
  attemptsByRepo: Map<number, { attemptedAt: Date; outcome: string; projectId: number }[]>;
  resurfaceMatchesByBookmarkId: Map<number, { matchId: number; projectId: number | null }[]>;
}) {
  if (list.length === 0) return null;
  return (
    <section style={{ marginTop: 36 }}>
      <h2 style={{ borderBottom: "1px solid var(--line)", paddingBottom: 4, marginBottom: 4 }}>🔖 Bookmarks ({list.length})</h2>
      <p className="meta" style={{ marginTop: 0, marginBottom: 12 }}>
        Replen re-evaluates each bookmark against every one of your projects every {RESURFACE_RETRY_DAYS} days. If your project goals change, a bookmark may resurface as a fit on your dashboard.
      </p>
      {list.map((m) => {
        const repo = repoMap.get(m.repoId);
        if (!repo) return null;
        const writeup = (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
        const attempts = attemptsByRepo.get(m.repoId) ?? [];
        const lastAttempt = attempts.length > 0
          ? attempts.reduce((a, b) => (+a.attemptedAt > +b.attemptedAt ? a : b))
          : null;
        const surfaced = resurfaceMatchesByBookmarkId.get(m.id) ?? [];
        return (
          <div className="match" key={m.id}>
            <div className="match-head">
              <RowCheck id={m.id} />
              <a className="repo" href={repo.url} target="_blank" rel="noreferrer">{repo.owner}/{repo.name}</a>
              <span className={`tag ${m.relevance}`}>{m.relevance} {m.relevanceScore ?? ""}</span>
              <span className="meta">
                {repo.stars ?? 0}★ · {repo.primaryLanguage ?? "?"} · saved {m.createdAt.toLocaleDateString()}
              </span>
              <form className="inline" action={async () => { "use server"; await setMatchStatus(m.id, "unread"); }}>
                <button title="Remove bookmark">🔖 remove</button>
              </form>
            </div>
            <div className="writeup">{writeup}</div>
            <ResurfaceStatus
              lastAttempt={lastAttempt}
              surfaced={surfaced}
              projectMap={projectMap}
            />
          </div>
        );
      })}
    </section>
  );
}

function ResurfaceStatus({ lastAttempt, surfaced, projectMap }: {
  lastAttempt: { attemptedAt: Date; outcome: string; projectId: number } | null;
  surfaced: { matchId: number; projectId: number | null }[];
  projectMap: Map<number, typeof schema.projectProfiles.$inferSelect>;
}) {
  const baseStyle: React.CSSProperties = { marginTop: 6, fontSize: 12, color: "var(--faint)" };

  if (surfaced.length > 0) {
    const links = surfaced.map((s, i) => {
      const slug = s.projectId ? projectMap.get(s.projectId)?.slug ?? "_unknown" : "_unknown";
      return (
        <span key={s.matchId}>
          {i > 0 ? ", " : ""}
          <a href={`/?project=${slug}#m-${s.matchId}`} style={{ color: "var(--amber)" }}>{slug}</a>
        </span>
      );
    });
    return (
      <p style={{ ...baseStyle, color: "var(--green)" }}>
        ✓ Surfaced as a fit for {links}
      </p>
    );
  }

  if (!lastAttempt) {
    return <p style={baseStyle}>Not yet checked against your other projects (runs nightly).</p>;
  }

  const nextRetry = new Date(+lastAttempt.attemptedAt + RESURFACE_RETRY_DAYS * 24 * 3600 * 1000);
  const daysLeft = Math.max(0, Math.ceil((+nextRetry - Date.now()) / (24 * 3600 * 1000)));
  return (
    <p style={baseStyle}>
      Last re-checked {lastAttempt.attemptedAt.toLocaleDateString()} — no fit yet for any project.
      Next retry in {daysLeft} {daysLeft === 1 ? "day" : "days"}.
    </p>
  );
}
