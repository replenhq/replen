import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client";

/**
 * Resolve a repo's id by owner/name, creating a minimal row if it doesn't exist.
 *
 * Most match candidates are CATALOGUE entries (catalogue_repos), not persisted
 * per-user repo rows — they arrive with repoId: null. Star/hide (/api/state) and
 * triage verdicts (/api/triage) both key off repos.id, so without this every
 * action on a catalogue match 404'd (and the L4 learning loop silently dropped
 * the verdict). We enrich the new row from the catalogue when present, else
 * synthesise a GitHub URL. Conflict-safe against the unique (owner,name) index
 * so concurrent callers (e.g. the onboarding sweep's parallel agents) don't race.
 */
export async function resolveOrCreateRepoId(owner: string, name: string): Promise<number> {
  const existing = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name)))
    .get();
  if (existing) return existing.id;

  const cat = await db
    .select()
    .from(schema.catalogueRepos)
    .where(sql`LOWER(${schema.catalogueRepos.fullName}) = ${`${owner}/${name}`.toLowerCase()}`)
    .get();
  const now = new Date();
  const inserted = await db
    .insert(schema.repos)
    .values({
      owner, name,
      url: cat?.url ?? `https://github.com/${owner}/${name}`,
      description: cat?.description ?? null,
      stars: cat?.stars ?? null,
      license: cat?.license ?? null,
      primaryLanguage: cat?.primaryLanguage ?? null,
      firstSeenAt: now, lastSeenAt: now,
    })
    .onConflictDoNothing({ target: [schema.repos.owner, schema.repos.name] })
    .returning({ id: schema.repos.id })
    .get();
  if (inserted?.id) return inserted.id;

  // Lost the insert race — the row now exists; re-select.
  const row = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name)))
    .get();
  if (!row) throw new Error(`could not resolve repo ${owner}/${name}`);
  return row.id;
}
