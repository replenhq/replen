#!/usr/bin/env -S npx tsx
// One-shot migration: rewrites any plaintext secrets in user_settings as
// AES-256-GCM (enc:v1:...) using ENCRYPTION_KEY. Idempotent — already-encrypted
// rows are skipped.
//
// Run:
//   set -a; . ./.env; set +a; npx tsx src/cli/encrypt-secrets.ts

import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { encryptSecret, isEncrypted } from "../lib/crypto";

if (!process.env.ENCRYPTION_KEY) {
  console.error("ENCRYPTION_KEY not set. Generate one:");
  console.error(`  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  console.error("Then add to .env on the host and re-run.");
  process.exit(1);
}

const rows = await db.select().from(schema.userSettings);
let updated = 0;
let skipped = 0;
for (const r of rows) {
  const patch: Record<string, string> = {};
  if (r.githubToken && !isEncrypted(r.githubToken)) patch.githubToken = encryptSecret(r.githubToken);
  if (r.deepseekApiKey && !isEncrypted(r.deepseekApiKey)) patch.deepseekApiKey = encryptSecret(r.deepseekApiKey);
  if (r.anthropicApiKey && !isEncrypted(r.anthropicApiKey)) patch.anthropicApiKey = encryptSecret(r.anthropicApiKey);
  if (Object.keys(patch).length === 0) { skipped++; continue; }
  await db.update(schema.userSettings).set(patch).where(eq(schema.userSettings.id, r.id));
  updated++;
  console.log(`  user_settings.id=${r.id} user_id=${r.userId} fields=${Object.keys(patch).join(",")}`);
}
console.log(`[encrypt-secrets] done. updated=${updated} skipped=${skipped} total=${rows.length}`);
process.exit(0);
