import { sql } from "drizzle-orm";
import { db } from "@/db/client";

// Erase a user and ALL of their data (right-to-erasure).
//
// IMPORTANT: the live schema has drift — several user_id foreign keys that
// schema.ts declares ON DELETE CASCADE were created ON DELETE NO ACTION by the
// migrations (candidates, matches, digest_runs, project_profiles). So a plain
// `DELETE FROM users` is BLOCKED, and cascade can't be relied on. There are also
// inter-table FKs (matches→candidates, graph_edges→graph_nodes) that make delete
// order matter.
//
// Rather than depend on either, we:
//   1. discover every table that has a user_id column at runtime (future-proof:
//      a new user-scoped table is erased automatically);
//   2. disable foreign-key enforcement for the erasure so order can't block us;
//   3. delete the user's rows from each of those tables, null the two
//      attribution-only columns on shared tables (curated_sources.added_by_user_id,
//      proposed_sources.reviewed_by_user_id), and delete the users row;
//   4. re-enable foreign-key enforcement.
export async function deleteUserAndAllData(userId: number): Promise<void> {
  const rows = await db.all<{ name: string }>(sql`
    SELECT m.name AS name FROM sqlite_master m
    WHERE m.type = 'table'
      AND m.name NOT LIKE 'sqlite_%'
      AND m.name NOT LIKE '__drizzle%'
      AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'user_id')
    ORDER BY m.name
  `);

  await db.run(sql`PRAGMA foreign_keys=OFF`);
  try {
    await db.transaction(async (tx) => {
      for (const { name } of rows) {
        await tx.run(sql`DELETE FROM ${sql.identifier(name)} WHERE user_id = ${userId}`);
      }
      // Shared tables: keep the row, drop this user's attribution.
      await tx.run(sql`UPDATE curated_sources SET added_by_user_id = NULL WHERE added_by_user_id = ${userId}`);
      await tx.run(sql`UPDATE proposed_sources SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id = ${userId}`);
      await tx.run(sql`DELETE FROM users WHERE id = ${userId}`);
    });
  } finally {
    await db.run(sql`PRAGMA foreign_keys=ON`);
  }
}
