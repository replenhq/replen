import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";
import {
  assertEncryptionKeyForBoot,
  decryptSecret,
  encryptForUserWithDek,
  generateDek,
  unwrapDek,
} from "../lib/crypto";

// Refuse to boot in production without ENCRYPTION_KEY. There is no silent
// plaintext fallback - misconfigured deploys must fail loud, not corrupt
// the secrets store.
assertEncryptionKeyForBoot();

const dbPath = process.env.DIGEST_DB_PATH ?? "./data/digest.sqlite";
const absPath = resolve(dbPath);
mkdirSync(dirname(absPath), { recursive: true });

const client = createClient({ url: `file:${absPath}` });
// Audit L6: enforce 0600 on the sqlite file (owner read/write only). Default
// umask drift can leave the file world-readable, which on a multi-tenant
// host exposes every match writeup, project profile, and DEK ciphertext to
// any logged-in user. Best-effort: a chmod failure shouldn't crash boot
// (e.g. read-only test fixtures), so swallow but log.
if (existsSync(absPath)) {
  try { chmodSync(absPath, 0o600); } catch (e) {
    console.warn(`[db] chmod 0600 on ${absPath} failed: ${(e as Error).message}`);
  }
}
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
// 30 minutes - covers the legitimate-running-pipeline edge case.
await client.execute({
  sql: `UPDATE digest_runs
        SET finished_at = strftime('%s','now'),
            error_log = COALESCE(error_log, 'reaped on startup - previous process died before completion')
        WHERE finished_at IS NULL
          AND started_at < strftime('%s','now') - 1800`,
  args: [],
}).catch((e) => console.error("[db] orphan reaper failed:", e));

// One-shot envelope upgrade: rewrap any v1-encrypted user_settings secrets
// under the user's per-tenant DEK (enc:v2). Idempotent - rows already in v2
// are detected by prefix and skipped. Needs ENCRYPTION_KEY available, so
// silently no-ops in dev environments without it.
if (process.env.ENCRYPTION_KEY) {
  await rewrapV1Secrets().catch((e) => console.error("[db] v1→v2 rewrap failed:", (e as Error).message));
}

async function rewrapV1Secrets(): Promise<void> {
  const rs = await client.execute({
    sql: `SELECT id, user_id, github_token, github_write_token, deepseek_api_key, anthropic_api_key, webhook_url
          FROM user_settings`,
    args: [],
  });
  if (rs.rows.length === 0) return;

  // Cache DEKs per user for the duration of this migration so we don't
  // re-fetch on every column.
  const dekCache = new Map<number, Buffer>();
  async function dekFor(userId: number): Promise<Buffer> {
    const cached = dekCache.get(userId);
    if (cached) return cached;
    const userRow = await client.execute({
      sql: `SELECT dek_ciphertext FROM users WHERE id = ?`,
      args: [userId],
    });
    const cipher = (userRow.rows[0] as unknown as { dek_ciphertext: string | null } | undefined)?.dek_ciphertext;
    let dek: Buffer;
    if (cipher) {
      dek = unwrapDek(cipher);
    } else {
      const fresh = generateDek();
      await client.execute({
        sql: `UPDATE users SET dek_ciphertext = ? WHERE id = ?`,
        args: [fresh.ciphertext, userId],
      });
      dek = fresh.dek;
      console.log(`[db] minted DEK for user ${userId}`);
    }
    dekCache.set(userId, dek);
    return dek;
  }

  const COLUMNS: Array<["github_token" | "github_write_token" | "deepseek_api_key" | "anthropic_api_key" | "webhook_url", string]> = [
    ["github_token", "githubToken"],
    ["github_write_token", "githubToken"],
    ["deepseek_api_key", "deepseekApiKey"],
    ["anthropic_api_key", "anthropicApiKey"],
    // webhook_url: was plaintext until audit M1. Same migration shape since
    // decryptSecret() returns plaintext input unchanged.
    ["webhook_url", "webhookUrl"],
  ];

  for (const r of rs.rows as unknown as Array<{
    id: number; user_id: number;
    github_token: string | null; github_write_token: string | null;
    deepseek_api_key: string | null; anthropic_api_key: string | null;
    webhook_url: string | null;
  }>) {
    const updates: Record<string, string> = {};
    for (const [col] of COLUMNS) {
      const v = r[col];
      if (!v || v.startsWith("enc:v2:")) continue;
      // v1 or legacy plaintext — promote to v2 under this user's DEK.
      try {
        const pt = decryptSecret(v);
        if (!pt) continue;
        const dek = await dekFor(r.user_id);
        updates[col] = encryptForUserWithDek(r.user_id, dek, pt);
      } catch (e) {
        console.warn(`[db] rewrap skip user_settings.id=${r.id} col=${col}: ${(e as Error).message}`);
      }
    }
    if (Object.keys(updates).length === 0) continue;
    const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    const args = [...Object.values(updates), r.id];
    await client.execute({
      sql: `UPDATE user_settings SET ${setClause} WHERE id = ?`,
      args,
    });
    console.log(`[db] rewrap user_settings.id=${r.id} cols=${Object.keys(updates).join(",")}`);
  }
}
