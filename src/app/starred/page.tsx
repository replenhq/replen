import { db, schema } from "@/db/client";
import { desc, eq, and, inArray } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { createHandoff, refreshHandoffStatuses, setMatchStatus } from "../actions";
import { BulkBar, RowCheck } from "./BulkBar";

export const dynamic = "force-dynamic";

// Standalone "starred" view - everything the user has flagged, partitioned by
// where it is in the handoff lifecycle. Useful because the dashboard's day-
// window filter hides older stars, but the user often wants to come back to a
// pile of "things I starred but haven't actioned yet".
//
// Buckets:
//   1. Awaiting handoff  - starred, no PR opened yet
//   2. Open / under review - PR opened but not merged
//   3. Integrated        - PR merged (integratedAt set)
export default async function Starred() {
  const user = await requireUser();

  const starred = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, user.id), eq(schema.matches.userStatus, "starred")))
    .orderBy(desc(schema.matches.createdAt));

  const repoIds = [...new Set(starred.map((m) => m.repoId))];
  const projectIds = [...new Set(starred.map((m) => m.projectId).filter((x): x is number => !!x))];
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

  const awaiting = starred.filter((m) => !m.handoffPrUrl);
  const openPr = starred.filter((m) => m.handoffPrUrl && !m.integratedAt && m.handoffPrStatus !== "merged");
  const integrated = starred.filter((m) => m.integratedAt || m.handoffPrStatus === "merged");

  async function refresh() {
    "use server";
    await refreshHandoffStatuses();
  }

  return (
    <>
      <h1>⭐ Starred</h1>
      <p className="meta">
        {starred.length} starred · {awaiting.length} awaiting handoff · {openPr.length} PR open · {integrated.length} integrated
      </p>
      {(openPr.length > 0 || awaiting.length > 0) && (
        <form action={refresh} style={{ margin: "8px 0 16px" }}>
          <button type="submit">↻ Refresh PR statuses</button>
          <span className="meta" style={{ marginLeft: 8 }}>polls open handoff PRs (last checked &gt; 30m ago)</span>
        </form>
      )}

      <BulkBar />

      <Section title={`Awaiting handoff (${awaiting.length})`} list={awaiting} repoMap={repoMap} projectMap={projectMap} bucket="awaiting" />
      <Section title={`PR open (${openPr.length})`} list={openPr} repoMap={repoMap} projectMap={projectMap} bucket="open" />
      <Section title={`Integrated (${integrated.length})`} list={integrated} repoMap={repoMap} projectMap={projectMap} bucket="integrated" />
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
      <h2 style={{ borderBottom: "1px solid #ccc4", paddingBottom: 4, marginBottom: 8 }}>{title}</h2>
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
                <span className="meta" style={{ color: "#a96" }}>
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
