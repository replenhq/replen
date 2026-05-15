import { db, schema } from "@/db/client";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { refreshHandoffStatuses } from "../actions";

export const dynamic = "force-dynamic";

// Wall of OSS we've actually integrated — handoff PRs that were merged.
// Both a sense of progress ("we shipped X external bits this quarter") and a
// reminder of what's already in the codebase so we don't re-evaluate it.
export default async function Integrated() {
  const user = await requireUser();

  const integrated = await db
    .select()
    .from(schema.matches)
    .where(and(
      eq(schema.matches.userId, user.id),
      or(isNotNull(schema.matches.integratedAt), eq(schema.matches.handoffPrStatus, "merged")),
    ))
    .orderBy(desc(schema.matches.integratedAt));

  const repoIds = [...new Set(integrated.map((m) => m.repoId))];
  const projectIds = [...new Set(integrated.map((m) => m.projectId).filter((x): x is number => !!x))];
  const repoMap = new Map<number, typeof schema.repos.$inferSelect>();
  if (repoIds.length > 0) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repoMap.set(r.id, r);
  }
  const projectMap = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (projectIds.length > 0) {
    const ps = await db.select().from(schema.projectProfiles).where(inArray(schema.projectProfiles.id, projectIds));
    for (const p of ps) projectMap.set(p.id, p);
  }

  // Group by project for at-a-glance "what each repo has absorbed".
  const byProject = new Map<string, typeof integrated>();
  for (const m of integrated) {
    const slug = m.projectId ? projectMap.get(m.projectId)?.slug ?? "_unknown" : "_general";
    if (!byProject.has(slug)) byProject.set(slug, []);
    byProject.get(slug)!.push(m);
  }

  async function refresh() {
    "use server";
    await refreshHandoffStatuses();
  }

  return (
    <>
      <h1>Integrated</h1>
      <p className="meta">{integrated.length} OSS {integrated.length === 1 ? "package" : "packages"} merged via handoff PRs.</p>

      <form action={refresh} style={{ margin: "8px 0 20px" }}>
        <button type="submit">↻ Refresh PR statuses</button>
        <span className="meta" style={{ marginLeft: 8 }}>polls open handoff PRs (last checked &gt; 30m ago)</span>
      </form>

      {integrated.length === 0 && (
        <p className="meta">
          Nothing merged yet. Star a match on the dashboard, click <b>→ handoff PR</b>, and once the PR is merged it shows up here.
        </p>
      )}

      {[...byProject.entries()].map(([slug, list]) => (
        <section key={slug} style={{ marginTop: 24 }}>
          <h2 style={{ borderBottom: "1px solid #ccc4", paddingBottom: 4 }}>
            {slug} <span className="meta" style={{ fontWeight: 400 }}>· {list.length}</span>
          </h2>
          <ul style={{ paddingLeft: 0, listStyle: "none" }}>
            {list.map((m) => {
              const repo = repoMap.get(m.repoId);
              if (!repo) return null;
              return (
                <li key={m.id} style={{ padding: "8px 0", borderBottom: "1px solid #ccc2" }}>
                  <a href={repo.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                    {repo.owner}/{repo.name}
                  </a>
                  <span className="meta" style={{ marginLeft: 8 }}>
                    {repo.stars ?? 0}★ · {repo.primaryLanguage ?? "?"} · {repo.license ?? "no license"}
                    {m.integratedAt && <> · merged {new Date(m.integratedAt).toLocaleDateString()}</>}
                  </span>
                  {m.handoffPrUrl && (
                    <>
                      {" · "}
                      <a href={m.handoffPrUrl} target="_blank" rel="noreferrer">PR ↗</a>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
