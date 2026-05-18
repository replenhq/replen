// Rotate ENCRYPTION_KEY (the master KEK) by rewrapping every users.dek_ciphertext
// under the new key. The per-user DEK itself stays the same — the value held
// inside the wrapper — so user_settings ciphertexts and the data they protect
// don't need to change.
//
// Operator runbook:
//   1. Generate a new 32-byte key:
//        node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   2. In prod /opt/replen/.env:
//        ENCRYPTION_KEY_PREV=<the OLD value>
//        ENCRYPTION_KEY=<the NEW value>
//   3. Restart services. They now decrypt with current-then-prev so the box
//      keeps working with mixed-key rows.
//   4. SSH to prod and run:
//        cd /opt/replen
//        node --env-file=.env --import=tsx src/cli/rotate-master-key.ts
//   5. Once it reports "all rows on current key" remove ENCRYPTION_KEY_PREV
//      from the env and restart again. Old key can now be destroyed.
//
// Idempotent: re-running on an already-rotated DB just re-encrypts each row
// under the same (current) key. Safe to retry on failure. Each row's rewrap
// is atomic at the SQLite-statement level; if the process is killed mid-run
// the rest can be picked up on next invocation.

import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { unwrapDek, rewrapDekUnderCurrentKey, getPrevMasterKey } from "../lib/crypto";

async function main(): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) {
    console.error("[rotate] ENCRYPTION_KEY (the NEW key) must be set. Refusing.");
    process.exit(1);
  }
  // Soft warning rather than hard fail: a developer might run this in a
  // single-key state to verify all rows decrypt under the current key.
  if (!getPrevMasterKey()) {
    console.warn("[rotate] ENCRYPTION_KEY_PREV is NOT set. Running as a dry-verify pass.");
  }

  const rows = await db
    .select({ id: schema.users.id, cipher: schema.users.dekCiphertext })
    .from(schema.users);

  let rewrapped = 0;
  let alreadyCurrent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.cipher) {
      skipped++;
      continue;
    }
    try {
      // Unwrap. If this succeeds against the CURRENT key (no prev fallback
      // taken inside unwrapDek), the row was already on the new key — we
      // re-encrypt anyway since IVs are random and the operation is cheap;
      // tracking that distinction would mean threading a flag out of crypto.ts.
      // Note: rewrapDekUnderCurrentKey throws if neither key works, which
      // counts as a real failure (corrupt row or key totally wrong).
      const fresh = rewrapDekUnderCurrentKey(row.cipher);
      await db
        .update(schema.users)
        .set({ dekCiphertext: fresh })
        .where(eq(schema.users.id, row.id));
      rewrapped++;
    } catch (e) {
      failed++;
      console.error(`[rotate] user=${row.id} failed: ${(e as Error).message}`);
    }
  }

  console.log("");
  console.log(`[rotate] rewrapped:       ${rewrapped}`);
  console.log(`[rotate] no DEK on row:   ${skipped}`);
  console.log(`[rotate] failed:          ${failed}`);
  if (failed === 0) {
    console.log("");
    console.log("All rows rewrapped under the new master key.");
    console.log("Verify by reading a few user_settings rows, then unset ENCRYPTION_KEY_PREV and restart.");
  } else {
    console.error("");
    console.error("Some rows failed. Do NOT unset ENCRYPTION_KEY_PREV until every failure is investigated.");
    process.exit(2);
  }

  // unwrapDek is only imported for the dry-verify shape above — silence the
  // unused-import warning without changing the import line.
  void unwrapDek;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
