// One-shot cleanup: take existing matches.writeup_md rows that are
// single dense paragraphs (no \n\n) and auto-split them at sentence
// boundaries. Same logic the analyzers now apply at write time —
// running it here retroactively fixes content already in the DB
// without a new LLM call.
//
// Run:
//   npx tsx src/scheduler/reformat-writeups.ts [user_id]
//
// If user_id omitted, runs across all users. Idempotent: matches
// that already have paragraph breaks are left alone.

import { db, schema } from "../db/client";
import { eq, isNotNull } from "drizzle-orm";
import { ensureParagraphs } from "../lib/writeup-format";

export async function reformatForUser(userId: number): Promise<{ scanned: number; rewritten: number }> {
  const rows = await db
    .select({ id: schema.matches.id, writeupMd: schema.matches.writeupMd })
    .from(schema.matches)
    .where(eq(schema.matches.userId, userId));

  let scanned = 0;
  let rewritten = 0;
  for (const r of rows) {
    scanned++;
    const original = r.writeupMd ?? "";
    if (!original) continue;
    const reformatted = ensureParagraphs(original);
    if (reformatted === original) continue;
    await db
      .update(schema.matches)
      .set({ writeupMd: reformatted })
      .where(eq(schema.matches.id, r.id));
    rewritten++;
  }
  console.log(`[reformat] user=${userId} scanned=${scanned} rewritten=${rewritten}`);
  return { scanned, rewritten };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cliUserId = process.argv[2] ? Number(process.argv[2]) : null;
  if (cliUserId !== null && Number.isFinite(cliUserId)) {
    await reformatForUser(cliUserId);
  } else {
    const users = await db.select({ id: schema.users.id }).from(schema.users).where(isNotNull(schema.users.id));
    for (const u of users) {
      await reformatForUser(u.id);
    }
  }
  process.exit(0);
}
