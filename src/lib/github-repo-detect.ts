// Auto-populates project_profiles.github_full_name by matching each project
// slug against the user's GitHub repos. Called from /settings on PAT save and
// from the "Re-detect" button on /projects.
//
// Skips projects that already have github_full_name set (don't clobber).
// Skips ambiguous matches (0 or >1 hits on the same slug).

import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";

export async function autoDetectAndStoreRepos(userId: number, token: string): Promise<{ filled: number; total: number; languages: string[] }> {
  if (!token) return { filled: 0, total: 0, languages: [] };

  // GitHub /user/repos returns primary `language` per repo (most-bytes
  // language, computed server-side). That's good enough for our purpose -
  // no need to call /languages per repo and burn rate-limit budget.
  // `fork` and `archived` are also returned; we drop forks and archives
  // since they bias the language mix toward whatever you pinned years ago.
  type Repo = { full_name: string; name: string; language: string | null; fork: boolean; archived: boolean; size: number };
  const repos: Repo[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "replen",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub /user/repos → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const batch = (await res.json()) as Repo[];
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  // Project repo matching - same as before.
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  let filled = 0;
  for (const p of projects) {
    if (p.githubFullName) continue;
    const matches = repos.filter((r) => r.name.toLowerCase() === p.slug.toLowerCase());
    if (matches.length !== 1) continue;
    await db
      .update(schema.projectProfiles)
      .set({ githubFullName: matches[0].full_name })
      .where(and(eq(schema.projectProfiles.id, p.id), eq(schema.projectProfiles.userId, userId)));
    filled++;
  }

  // Language detection - count repos per primary language across the user's
  // own non-fork, non-archived repos. Repo count (not size) because a single
  // huge mono-repo with Makefile as primary would otherwise swamp the signal.
  // Also drops build / config languages that rarely produce useful trending
  // pages (you don't read /trending/makefile).
  const IGNORE = new Set(["Makefile", "Dockerfile", "Shell", "Batchfile", "PowerShell", "PLSQL", "TSQL", "PLpgSQL", "HCL", "Roff", "TeX", "HTML", "CSS", "SCSS", "Less", "MDX"]);
  const tally = new Map<string, number>();
  for (const r of repos) {
    if (r.fork || r.archived || !r.language) continue;
    if (IGNORE.has(r.language)) continue;
    tally.set(r.language, (tally.get(r.language) ?? 0) + 1);
  }
  const languages = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => k);
  if (languages.length > 0) {
    const existing = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).get();
    const csv = languages.join(",");
    if (existing) {
      await db.update(schema.userSettings).set({ detectedLanguages: csv, updatedAt: new Date() }).where(eq(schema.userSettings.userId, userId));
    } else {
      await db.insert(schema.userSettings).values({ userId, detectedLanguages: csv, updatedAt: new Date() });
    }
  }

  console.log(`[github-repo-detect] user=${userId} filled=${filled}/${projects.length} languages=${languages.join(",")}`);
  return { filled, total: projects.length, languages };
}
