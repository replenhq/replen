// Lists the user's GitHub repos via /user/repos. Two effects:
//   1. CREATE project_profiles rows for repos the user doesn't yet have
//      a project for (matched by slug). New rows land with active=true,
//      included=true, sensitivity=low, llm_provider=auto, and a stub
//      profileHash so the loader can pick them up on the next pipeline
//      run and fill in the docs. This is what makes first-run-after-
//      signup actually have something to match against — previously
//      this function only filled in github_full_name on pre-existing
//      rows, leaving fresh accounts with zero projects → zero matches.
//   2. For existing rows whose github_full_name is blank, fill it in by
//      matching repo.name to project.slug. Skips ambiguous matches.
// Also detects the user's primary languages (most-used across non-fork,
// non-archived repos) and writes them to user_settings for the gh-trending
// fetcher.

import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";

export async function autoDetectAndStoreRepos(userId: number, token: string): Promise<{ filled: number; created: number; total: number; languages: string[] }> {
  if (!token) return { filled: 0, created: 0, total: 0, languages: [] };

  // GitHub /user/repos returns primary `language` per repo (most-bytes
  // language, computed server-side). That's good enough for our purpose -
  // no need to call /languages per repo and burn rate-limit budget.
  // `fork` and `archived` are also returned; we drop forks and archives
  // since they bias the language mix toward whatever you pinned years ago.
  type Repo = { full_name: string; name: string; description: string | null; language: string | null; fork: boolean; archived: boolean; size: number };
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

  const existing = await db
    .select()
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));
  const existingBySlug = new Map(existing.map((p) => [p.slug.toLowerCase(), p]));
  const existingByFullName = new Map(
    existing.filter((p) => p.githubFullName).map((p) => [p.githubFullName!.toLowerCase(), p]),
  );

  // Pass 1: fill in github_full_name on existing rows where it's blank
  // and a single matching repo can be identified by slug. Skip ambiguous
  // matches (0 or >1 hits on the same slug).
  let filled = 0;
  for (const p of existing) {
    if (p.githubFullName) continue;
    const matches = repos.filter((r) => r.name.toLowerCase() === p.slug.toLowerCase());
    if (matches.length !== 1) continue;
    await db
      .update(schema.projectProfiles)
      .set({ githubFullName: matches[0].full_name })
      .where(and(eq(schema.projectProfiles.id, p.id), eq(schema.projectProfiles.userId, userId)));
    filled++;
  }

  // Pass 2: create new rows for repos that don't have a project yet. Skip
  // forks + archives — same reason we don't count them in the language
  // tally. Skip if a project with the same slug already exists (covered
  // by pass 1) or a project already points at this full_name. The loader
  // will fill in readme/claude/manifest docs on the next pipeline run.
  let created = 0;
  for (const r of repos) {
    if (r.fork || r.archived) continue;
    const slug = r.name.toLowerCase();
    if (existingBySlug.has(slug)) continue;
    if (existingByFullName.has(r.full_name.toLowerCase())) continue;
    await db.insert(schema.projectProfiles).values({
      userId,
      slug,
      name: r.name,
      // `path` is required + retained from the legacy laptop-sync model. For
      // GitHub-sourced projects there's no filesystem path, so we use the
      // owner/name form as a sensible identifier. The loader will hydrate
      // readmeMd / claudeMd / manifest content from GitHub on the next run.
      path: r.full_name,
      githubFullName: r.full_name,
      // Stub hash — the loader bumps this when it actually reads docs.
      profileHash: "pending",
      active: true,
      included: true,
      sensitivity: "low",
      llmProvider: "auto",
      updatedAt: new Date(),
    });
    created++;
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
    const existingSettings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).get();
    const csv = languages.join(",");
    if (existingSettings) {
      await db.update(schema.userSettings).set({ detectedLanguages: csv, updatedAt: new Date() }).where(eq(schema.userSettings.userId, userId));
    } else {
      await db.insert(schema.userSettings).values({ userId, detectedLanguages: csv, updatedAt: new Date() });
    }
  }

  const totalAfter = existing.length + created;
  console.log(`[github-repo-detect] user=${userId} filled=${filled}/${existing.length} created=${created} total=${totalAfter} languages=${languages.join(",")}`);
  return { filled, created, total: totalAfter, languages };
}
