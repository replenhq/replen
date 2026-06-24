// CI GUARD — a FRESH-DB migrate must succeed and apply EVERY migration. There have
// been two migration-class incidents (0072 missing a breakpoint; then the
// 0050/0052/0053 duplicate-column collision) that each silently produced an EMPTY
// database — breaking the open-core self-host promise (the documented `npm run
// db:migrate` after a clone). drizzle snapshots stopped at ~0021, so every migration
// since is hand-authored and collision-prone, and the failure modes (dropped
// statements, duplicate-column crashes, statement-less no-ops) are NOT caught by a
// breakpoint-lint heuristic — only an empirical migrate-and-assert catches them all.
//
// Run against a THROWAWAY db (the npm script sets a temp DIGEST_DB_PATH):
//   npm run db:migrate:check
// Exits non-zero on any migrate error OR if recorded migrations != .sql file count.

import { readdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./client";

async function main() {
  const files = readdirSync("./src/db/migrations").filter((f) => f.endsWith(".sql")).length;
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  const recRows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
  const tblRows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`);
  const recorded = Number(recRows[0]?.n ?? 0);
  const tables = Number(tblRows[0]?.n ?? 0);
  if (recorded !== files) {
    console.error(`FAIL: ${recorded} migrations recorded != ${files} .sql files — fresh self-host migrate is incomplete.`);
    process.exit(1);
  }
  console.log(`OK: ${recorded}/${files} migrations applied, ${tables} tables. Fresh self-host migrate is clean.`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL: fresh migrate crashed —", e instanceof Error ? e.message : e); process.exit(1); });
