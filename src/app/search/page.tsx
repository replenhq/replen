import { db, schema } from "@/db/client";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

// Plain-LIKE search across match writeup + repo metadata. SQLite FTS5 would be
// faster but the per-user dataset is small enough (low thousands of rows) that
// scanning is fine and saves us a virtual-table + trigger setup.
//
// Searches: match summary / why_useful / suggested_use / writeup_md, repo
// owner / name / description. Multi-tenant isolation via matches.userId.
export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();

  let results: Array<{
    match: typeof schema.matches.$inferSelect;
    repo: typeof schema.repos.$inferSelect;
    project: typeof schema.projectProfiles.$inferSelect | null;
  }> = [];

  if (q && q.length >= 2) {
    const needle = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    // Join matches → repos → projects on the SQL side. Drizzle's leftJoin
    // returns nested rows.
    const rows = await db
      .select({
        match: schema.matches,
        repo: schema.repos,
        project: schema.projectProfiles,
      })
      .from(schema.matches)
      .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
      .leftJoin(schema.projectProfiles, and(
        eq(schema.matches.projectId, schema.projectProfiles.id),
        eq(schema.projectProfiles.userId, user.id),
      ))
      .where(
        and(
          eq(schema.matches.userId, user.id),
          or(
            like(schema.matches.summary, needle),
            like(schema.matches.whyUseful, needle),
            like(schema.matches.suggestedUse, needle),
            like(schema.matches.writeupMd, needle),
            like(schema.matches.personalNote, needle),
            like(schema.repos.owner, needle),
            like(schema.repos.name, needle),
            like(schema.repos.description, needle),
            sql`lower(${schema.repos.owner}) || '/' || lower(${schema.repos.name}) like ${needle.toLowerCase()}`,
          ),
        ),
      )
      .orderBy(desc(schema.matches.createdAt))
      .limit(200);
    results = rows;
  }

  return (
    <>
      <h1>Search</h1>
      <form method="get" style={{ marginBottom: 16 }}>
        <input
          name="q"
          defaultValue={q}
          placeholder="repo, keyword, project, note…"
          autoFocus
          style={{ padding: 8, width: "100%", maxWidth: 480, fontSize: 14 }}
        />
        <button type="submit" style={{ marginLeft: 8, padding: "8px 16px" }}>Search</button>
      </form>

      {q && q.length < 2 && <p className="meta">Type at least 2 characters.</p>}
      {q && q.length >= 2 && (
        <p className="meta">{results.length} {results.length === 1 ? "result" : "results"} for &ldquo;{q}&rdquo;</p>
      )}

      {results.map(({ match: m, repo, project }) => {
        const writeup = (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
        return (
          <div className="match" key={m.id}>
            <div className="match-head">
              <a className="repo" href={repo.url} target="_blank" rel="noreferrer">{repo.owner}/{repo.name}</a>
              <span className={`tag ${m.relevance}`}>{m.relevance} {m.relevanceScore ?? ""}</span>
              <span className="meta">
                {project ? <>→ <a href={`/?project=${project.slug}`}>{project.slug}</a> · </> : "_general · "}
                {repo.stars ?? 0}★ · {repo.primaryLanguage ?? "?"} · {new Date(m.createdAt).toLocaleDateString()}
              </span>
              {m.userStatus === "starred" && <span className="tag" style={{ background: "#fffbe6" }}>⭐</span>}
              {m.handoffPrUrl && (
                <a href={m.handoffPrUrl} target="_blank" rel="noreferrer" className="tag" style={{ background: "#a4d8a4", color: "#1a1a1a", textDecoration: "none" }}>↗ PR</a>
              )}
            </div>
            <div className="writeup">{writeup}</div>
            {m.personalNote && <p className="meta" style={{ fontStyle: "italic" }}>📝 {m.personalNote}</p>}
          </div>
        );
      })}
    </>
  );
}
