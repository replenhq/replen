import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function RepoView({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const match = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.id, Number(id)), eq(schema.matches.userId, user.id)))
    .get();
  if (!match) return notFound();
  const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, match.repoId)).get();
  const project = match.projectId
    ? await db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, match.projectId)).get()
    : null;

  return (
    <>
      <p><a href="/">← back</a></p>
      <h1>{repo?.owner}/{repo?.name}</h1>
      <p className="meta">{project ? `for project: ${project.slug}` : "general awareness"} · <a href={repo?.url} target="_blank" rel="noreferrer">{repo?.url}</a></p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{match.writeupMd}</pre>
    </>
  );
}
