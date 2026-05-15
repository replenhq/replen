// One-shot: run autoDetectAndStoreRepos for every active user that has a
// GitHub PAT on file. Surfaces detected_languages immediately rather than
// waiting for each user to click the "Re-detect" button on /settings.

import { db, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { readUserSecret } from "../lib/user-secrets";
import { autoDetectAndStoreRepos } from "../lib/github-repo-detect";

async function main() {
  const users = await db.select().from(schema.users).where(eq(schema.users.status, "active"));
  for (const u of users) {
    const s = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    const tokenStored = s?.githubToken ?? s?.githubWriteToken ?? null;
    if (!tokenStored) {
      console.log(`[redetect] user=${u.id} (${u.email}) no PAT - skip`);
      continue;
    }
    let token: string | null = null;
    try { token = await readUserSecret(u.id, "githubToken", tokenStored, "redetect-languages"); } catch { console.warn(`[redetect] user=${u.id} decrypt fail`); continue; }
    if (!token) { console.warn(`[redetect] user=${u.id} decrypt empty`); continue; }
    try {
      const r = await autoDetectAndStoreRepos(u.id, token);
      console.log(`[redetect] user=${u.id} (${u.email}) languages=[${r.languages.join(",")}] filled=${r.filled}/${r.total}`);
    } catch (e) {
      console.warn(`[redetect] user=${u.id} failed: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
