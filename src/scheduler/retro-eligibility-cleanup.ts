// Pipeline v2 Sprint 4 part 2 — retroactive eligibility cleanup.
//
// Sprint 2's eligibility filter blocks NEW candidates from becoming
// matches. But every match created BEFORE the filter shipped stays in
// the matches table forever (until the 90-day archive sweeps it). That
// means a freshly-toggled user still sees pre-Sprint-2 noise — Composio,
// awesome-* lists, Python-tool-for-Node-project, etc. — in their feed
// even though new pipeline runs correctly block those same shapes.
//
// This script closes that gap: for every match in the matches table,
// look up the underlying candidate's inventory tags (primary_language,
// repo_shape, posted_at, score), re-run checkEligibility against
// today's rules, and soft-hide any match that would now fail.
//
// "Soft-hide" = user_status='hidden' (reversible, writeup preserved).
// Same UX as the user manually hiding a card. Surface them with a
// counter on each run so the user knows what happened.
//
// Run:
//   npx tsx src/scheduler/retro-eligibility-cleanup.ts [user_id]
// If user_id omitted, runs across all active users. Idempotent —
// matches already hidden by previous runs stay hidden; eligible
// matches stay where they are.

import { db, schema } from "../db/client";
import { and, eq, ne, isNull, inArray } from "drizzle-orm";
import { checkEligibility, type EligibilityInput } from "../analyzer/eligibility";
import { getKnownDeps } from "../analyzer/known-deps";
import { readUserSecret } from "../lib/user-secrets";
import type { RepoShape } from "../fetchers/repo-shape";

export async function retroCleanForUser(userId: number): Promise<{ scanned: number; hidden: number; byReason: Record<string, number> }> {
  // Pull every non-hidden, non-archived match for this user. Inner-join
  // with repos so we have the github URL; left-join with the latest
  // candidate row per (user, github_url) for the inventory tags. A
  // single match in the DB might be backed by multiple candidate rows
  // (different fetchers found the same repo); we just need one to
  // probe eligibility, so we pick the most recently fetched.
  const matchRows = await db
    .select({
      matchId: schema.matches.id,
      repoId: schema.matches.repoId,
      relevance: schema.matches.relevance,
      relevanceScore: schema.matches.relevanceScore,
      userStatus: schema.matches.userStatus,
      sourceKind: schema.matches.sourceKind,
      repoUrl: schema.repos.url,
      repoOwner: schema.repos.owner,
      repoName: schema.repos.name,
      repoPrimaryLanguage: schema.repos.primaryLanguage,
      repoCreatedAt: schema.repos.createdAt,
      repoStars: schema.repos.stars,
    })
    .from(schema.matches)
    .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
    .where(and(
      eq(schema.matches.userId, userId),
      ne(schema.matches.userStatus, "hidden"),
      isNull(schema.matches.archivedAt),
    ));

  if (matchRows.length === 0) {
    console.log(`[retro-clean] user=${userId} no matches to scan`);
    return { scanned: 0, hidden: 0, byReason: {} };
  }

  // Detected languages from user_settings (for the language-family
  // eligibility rule). Pull once.
  const settings = await db
    .select({ detectedLanguages: schema.userSettings.detectedLanguages, githubToken: schema.userSettings.githubToken })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  // Known-deps set (Layer A + B) — needs the user's GitHub PAT decrypted
  // to fetch manifests. If we can't get it, the known-deps rule simply
  // doesn't fire for this run, same graceful-degradation as the live
  // pipeline.
  let ghToken: string | null = null;
  if (settings?.githubToken) {
    try { ghToken = await readUserSecret(userId, "github_token", settings.githubToken, "migration"); }
    catch { ghToken = null; }
  }
  const knownDeps = await getKnownDeps(userId, ghToken).catch(() => new Set<string>());
  const ctx = {
    detectedLanguages: settings?.detectedLanguages ?? null,
    knownDeps,
  };

  // Pull the latest candidate row per github url for inventory tags. One
  // batched query rather than N+1.
  const repoUrls = [...new Set(matchRows.map((r) => r.repoUrl))];
  const candidateRows = repoUrls.length === 0 ? [] : await db
    .select({
      githubUrl: schema.candidates.githubUrl,
      primaryLanguage: schema.candidates.primaryLanguage,
      repoShape: schema.candidates.repoShape,
      postedAt: schema.candidates.postedAt,
      score: schema.candidates.score,
      source: schema.candidates.source,
      fetchedAt: schema.candidates.fetchedAt,
    })
    .from(schema.candidates)
    .where(and(
      eq(schema.candidates.userId, userId),
      inArray(schema.candidates.githubUrl, repoUrls),
    ));
  // Map github_url → latest candidate by fetchedAt
  const latestCandByUrl = new Map<string, typeof candidateRows[number]>();
  for (const c of candidateRows) {
    if (!c.githubUrl) continue;
    const prev = latestCandByUrl.get(c.githubUrl);
    if (!prev || (c.fetchedAt && (!prev.fetchedAt || c.fetchedAt > prev.fetchedAt))) {
      latestCandByUrl.set(c.githubUrl, c);
    }
  }

  const toHide: number[] = [];
  const byReason: Record<string, number> = {};
  for (const m of matchRows) {
    const cand = latestCandByUrl.get(m.repoUrl);
    // Build the eligibility input. Prefer candidate inventory tags
    // (Sprint 1's repo_shape classifier ran on these); fall back to
    // the repos row's primary_language + stars + created_at when no
    // candidate row exists (rare: match without a backing candidate
    // — possible for synthesis-generated or hand-ingested rows).
    const input: EligibilityInput = {
      primaryLanguage: cand?.primaryLanguage ?? m.repoPrimaryLanguage ?? null,
      repoShape: (cand?.repoShape as RepoShape | null) ?? null,
      postedAt: cand?.postedAt ?? m.repoCreatedAt ?? null,
      score: cand?.score ?? m.repoStars ?? null,
      source: cand?.source ?? m.sourceKind ?? "unknown",
      owner: m.repoOwner,
      name: m.repoName,
    };
    const verdict = checkEligibility(input, ctx);
    if (!verdict.eligible) {
      toHide.push(m.matchId);
      byReason[verdict.reason] = (byReason[verdict.reason] ?? 0) + 1;
    }
  }

  if (toHide.length === 0) {
    console.log(`[retro-clean] user=${userId} scanned=${matchRows.length} hidden=0 (all matches pass current eligibility)`);
    return { scanned: matchRows.length, hidden: 0, byReason: {} };
  }

  await db
    .update(schema.matches)
    .set({ userStatus: "hidden" })
    .where(and(
      eq(schema.matches.userId, userId),
      inArray(schema.matches.id, toHide),
    ));

  const reasonSummary = Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${n}× ${r}`)
    .join(", ");
  console.log(`[retro-clean] user=${userId} scanned=${matchRows.length} hidden=${toHide.length} (${reasonSummary})`);
  return { scanned: matchRows.length, hidden: toHide.length, byReason };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cliUserId = process.argv[2] ? Number(process.argv[2]) : null;
  if (cliUserId !== null && Number.isFinite(cliUserId)) {
    await retroCleanForUser(cliUserId);
  } else {
    const users = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.status, "active"));
    for (const u of users) await retroCleanForUser(u.id);
  }
  process.exit(0);
}
