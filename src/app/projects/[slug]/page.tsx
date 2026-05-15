import { db, schema } from "@/db/client";
import { desc, eq, ne, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function ProjectView({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const project = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.slug, slug)))
    .get();
  if (!project) return notFound();
  const matches = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, user.id), eq(schema.matches.projectId, project.id), ne(schema.matches.userStatus, "hidden")))
    .orderBy(desc(schema.matches.relevanceScore));

  const cards = await Promise.all(
    matches.map(async (m) => {
      const r = await db.select().from(schema.repos).where(eq(schema.repos.id, m.repoId)).get();
      return { m, r };
    })
  );

  return (
    <>
      <h1>{project.name}</h1>
      <p className="meta">{project.path}</p>
      <h2>Matches</h2>
      {cards.length === 0 && <p>No matches yet.</p>}
      {cards.map(({ m, r }) => {
        if (!r) return null;
        const writeup = (m.writeupMd ?? "").split("\n\n— — —\n")[0]?.trim() || m.summary || "";
        return (
          <div className="match" key={m.id}>
            <div className="match-head">
              <a className="repo" href={r.url} target="_blank" rel="noreferrer">{r.owner}/{r.name}</a>
              <span className={`tag ${m.relevance}`}>{m.relevance} {m.relevanceScore ?? ""}</span>
              <span className="meta">{r.stars ?? 0}★</span>
            </div>
            <div className="writeup">{writeup}</div>
          </div>
        );
      })}
    </>
  );
}
