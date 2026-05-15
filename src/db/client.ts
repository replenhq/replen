import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

const dbPath = process.env.DIGEST_DB_PATH ?? "./data/digest.sqlite";
const absPath = resolve(dbPath);
mkdirSync(dirname(absPath), { recursive: true });

const client = createClient({ url: `file:${absPath}` });
// Absorb concurrent reader/writer locks (the dashboard reads while the pipeline writes).
await client.execute("PRAGMA busy_timeout = 8000");
await client.execute("PRAGMA journal_mode = WAL");
export const db = drizzle(client, { schema });
export { schema };

// One-time orphan reaper on module load. If a previous process was killed
// (deploy restart, OOM, etc.) any digest_runs row it created stays with
// finished_at = NULL forever, blocking the "Run pipeline now" button. Mark
// any leftover unfinished run from BEFORE this process started as crashed.
// Safe because: (a) a real in-flight run from THIS process can't have been
// inserted yet, and (b) we only update rows whose started_at is older than
// 30 minutes — covers the legitimate-running-pipeline edge case.
await client.execute({
  sql: `UPDATE digest_runs
        SET finished_at = strftime('%s','now'),
            error_log = COALESCE(error_log, 'reaped on startup — previous process died before completion')
        WHERE finished_at IS NULL
          AND started_at < strftime('%s','now') - 1800`,
  args: [],
}).catch((e) => console.error("[db] orphan reaper failed:", e));
