import { sql } from "drizzle-orm";
import { db, schema } from "../db/client";

// Repo identity is case-insensitive (GitHub owner/name are ASCII and
// case-insensitive). Match on lower(owner)/lower(name) so "Owner/Repo"
// and "owner/repo" resolve to the same row. Backed by the unique index
// uniq_repo_ci; see migration 0077. Both sides are folded with SQL lower() (not
// JS toLowerCase on one side) so the comparison is internally consistent even
// for non-ASCII input — SQLite's lower() folds ASCII only, and folding the
// parameter the same way keeps a lookup and its index in agreement. Any call
// site that looks up a repo by owner/name MUST use this, or it will miss a
// differently-cased existing row and then trip uniq_repo_ci on insert.
export const repoCiMatch = (owner: string, name: string) =>
  sql`lower(${schema.repos.owner}) = lower(${owner}) and lower(${schema.repos.name}) = lower(${name})`;

/**
 * Resolve a repo's id by owner/name, creating a minimal row if it doesn't exist.
 *
 * Most match candidates are CATALOGUE entries (catalogue_repos), not persisted
 * per-user repo rows — they arrive with repoId: null. Star/hide (/api/state) and
 * triage verdicts (/api/triage) both key off repos.id, so without this every
 * action on a catalogue match 404'd (and the L4 learning loop silently dropped
 * the verdict). We enrich the new row from the catalogue when present, else
 * synthesise a GitHub URL. Identity is case-insensitive: the lookup folds case,
 * and the insert conflicts on uniq_repo_ci so concurrent callers (e.g. the
 * onboarding sweep's parallel agents) or a differently-cased sighting of the
 * same repo never mint a duplicate row. The first writer's casing is preserved.
 */
export async function resolveOrCreateRepoId(owner: string, name: string): Promise<number> {
  const existing = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(repoCiMatch(owner, name))
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
    // No target: the only unique index on repos is uniq_repo_ci (case-insensitive),
    // so a bare ON CONFLICT DO NOTHING catches a case-variant collision too.
    .onConflictDoNothing()
    .returning({ id: schema.repos.id })
    .get();
  if (inserted?.id) return inserted.id;

  // Lost the insert race (or a case-variant already existed) — re-select.
  const row = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(repoCiMatch(owner, name))
    .get();
  if (!row) throw new Error(`could not resolve repo ${owner}/${name}`);
  return row.id;
}
