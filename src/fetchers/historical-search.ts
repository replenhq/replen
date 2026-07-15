import type { Fetcher, FetchedCandidate, FetcherContext } from "./types";
import { inferRepoShape } from "./repo-shape";
import { shouldSkip } from "./big-co";
import { readRunOrEnv } from "../analyzer/run-context";
import { db, schema } from "../db/client";
import { and, eq, like } from "drizzle-orm";

// Pipeline v2 / Sprint 1 — historical inventory layer.
//
// gh-trending reaches back ~30 days. ossinsight-trending stops at 3 months.
// gh-search-recent is a forward window ("anything created since 2025-09-01").
// None of those surface the LONG TAIL: established libraries the user has
// never run into, classic repos that haven't been hot recently but solve a
// problem the user actually has. That's what this fetcher is for.
//
// Strategy: GitHub /search/repositories paginated across MONTH windows,
// going back WINDOWS_MONTHS from today. Per (language, month) window we
// keep the top PER_WINDOW_CAP by star count, filtered by STARS_MIN to keep
// junk out. Monthly buckets give us a balanced spread across the time
// range — without them, sort-by-stars-desc would just return the same
// 100 megaprojects every time and starve the long tail.
//
// First-run vs subsequent:
//   - First time we see a user (no historical-search candidates exist),
//     walk back the full WINDOWS_MONTHS. Heavy but one-time.
//   - Subsequent runs only re-walk the most recent few months
//     (REFRESH_RECENT_MONTHS) so we catch drift — repos crossing the
//     stars threshold or new releases in recently-busy ecosystems.
// Detection is a single `select count(*)` against the candidates table.
//
// Rate limit: GitHub search API allows 30 req/min for authenticated users
// (5 lang × 24 months = 120 calls first-run = ~4 min spread by spacing each
// call ~2.2s apart). Spacing avoids the burst that gets us 403'd.

const WINDOWS_MONTHS = parseInt(process.env.HISTORICAL_WINDOWS_MONTHS ?? "24", 10);
const REFRESH_RECENT_MONTHS = parseInt(process.env.HISTORICAL_REFRESH_RECENT_MONTHS ?? "2", 10);
const STARS_MIN = parseInt(process.env.HISTORICAL_STARS_MIN ?? "500", 10);
const PER_WINDOW_CAP = parseInt(process.env.HISTORICAL_PER_WINDOW_CAP ?? "15", 10);
const MAX_LANGS = parseInt(process.env.HISTORICAL_MAX_LANGS ?? "5", 10);
const REQUEST_SPACING_MS = parseInt(process.env.HISTORICAL_REQUEST_SPACING_MS ?? "2200", 10);

// Same canonical-language convention as gh-search-recent: pass-through what
// the loader detected (e.g. "TypeScript", "Python"). GitHub's `language:`
// qualifier needs the canonical form.
const FALLBACK_LANGS = ["TypeScript", "Python", "Rust", "Go"];

function monthKey(d: Date): { start: string; end: string } {
  // First day of the month at 00:00 UTC. End is exclusive — last day of
  // the SAME month (search qualifier is inclusive on both ends but we
  // shift by one day to keep windows non-overlapping).
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function monthsAgo(n: number): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const historicalSearchFetcher: Fetcher = {
  name: "historical-search",
  async run(ctx?: FetcherContext): Promise<FetchedCandidate[]> {
    const userId = ctx?.userId;
    if (!userId) {
      // Historical search is strictly per-user — needs the user's PAT for
      // authentication AND a way to dedupe first-run vs refresh. Skip
      // cleanly if called without a user (defence; the orchestrator
      // shouldn't do this anyway).
      console.log("[historical-search] no userId in context, skipping");
      return [];
    }

    const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
    if (!ghToken) {
      // Search API unauthenticated is 10 req/min — not workable at our
      // call volume. Skip rather than burn rate budget on partial coverage.
      console.log("[historical-search] no GitHub token; skipping");
      return [];
    }

    const detected = (ctx?.detectedLanguages ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const langs = (detected.length > 0 ? detected : FALLBACK_LANGS).slice(0, MAX_LANGS);

    // First-run detection: does this user have ANY historical-search
    // candidates yet? If no, walk back the full window. If yes, only
    // refresh the recent months — the long-tail pool doesn't drift fast
    // enough to justify re-fetching old months every day.
    const seenAny = await db
      .select({ id: schema.candidates.id })
      .from(schema.candidates)
      .where(and(
        eq(schema.candidates.userId, userId),
        like(schema.candidates.source, "historical-search:%"),
      ))
      .limit(1)
      .get();
    const isFirstRun = !seenAny;
    const monthsToFetch = isFirstRun ? WINDOWS_MONTHS : REFRESH_RECENT_MONTHS;
    console.log(
      `[historical-search] user=${userId} ${isFirstRun ? "first-run" : "refresh"} — walking ${monthsToFetch} months × ${langs.length} langs (${langs.join(",")})`,
    );

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "replen/0.1",
      Authorization: `Bearer ${ghToken}`,
    };

    const out: FetchedCandidate[] = [];
    const seen = new Set<string>();

    for (const lang of langs) {
      let langKept = 0;
      for (let m = 0; m < monthsToFetch; m++) {
        const windowDate = monthsAgo(m);
        const { start, end } = monthKey(windowDate);
        // The qualifier: explicit language, stars floor, created within
        // the month window. Sort by stars desc + take the top PER_WINDOW_CAP.
        const q = `language:"${lang}" stars:>=${STARS_MIN} created:${start}..${end}`;
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_WINDOW_CAP}`;

        let items: Array<Record<string, unknown>> = [];
        try {
          const res = await fetch(url, { headers });
          if (res.status === 403) {
            // Rate-limited — bail this run, the next run will pick up
            // where we left off (next call returns the same window
            // dedupe-protected by the unique constraint).
            console.warn(`[historical-search] 403 from GitHub on ${lang}/${start} — assuming rate-limited, stopping run`);
            return out;
          }
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.warn(`[historical-search] ${lang} ${start}: HTTP ${res.status} ${body.slice(0, 160)}`);
            await sleep(REQUEST_SPACING_MS);
            continue;
          }
          const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
          items = json.items ?? [];
        } catch (e) {
          console.warn(`[historical-search] ${lang} ${start}: fetch failed`, e);
          await sleep(REQUEST_SPACING_MS);
          continue;
        }

        for (const item of items) {
          const fullName = String(item.full_name ?? "");
          const [owner, name] = fullName.split("/");
          if (!owner || !name) continue;
          if (seen.has(fullName)) continue;
          seen.add(fullName);

          const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
          const verdict = shouldSkip(owner, stars);
          if (verdict.skip) continue;
          const description = String(item.description ?? "").trim();
          const language = typeof item.language === "string" ? item.language : null;
          const topicsRaw = Array.isArray(item.topics) ? (item.topics as unknown[]).filter((t) => typeof t === "string") as string[] : [];
          const createdAt = item.created_at ? new Date(String(item.created_at)) : null;
          const pushedAt = item.pushed_at ? new Date(String(item.pushed_at)) : null;

          out.push({
            source: `historical-search:${lang}`,
            sourceItemId: fullName,
            title: `${fullName} - ${description}`.slice(0, 280),
            url: `https://github.com/${fullName}`,
            githubUrl: `https://github.com/${fullName}`,
            author: owner,
            score: stars,
            postedAt: createdAt ?? pushedAt,
            createdAt, // true repo birth date (drives the frontier prior)
            raw: {
              owner,
              name,
              description,
              stars,
              language,
              window: { lang, start, end },
              createdAt: createdAt?.toISOString() ?? null,
              pushedAt: pushedAt?.toISOString() ?? null,
              topics: topicsRaw,
            },
            primaryLanguage: language || lang,
            topics: topicsRaw,
            repoShape: inferRepoShape({ name, description, topics: topicsRaw }),
          });
          langKept++;
        }
        // Spacing between requests so we don't burst the 30/min search
        // rate limit. ~2.2s per call = 27 calls/min, sustainable.
        await sleep(REQUEST_SPACING_MS);
      }
      console.log(`[historical-search] ${lang}: ${langKept} kept across ${monthsToFetch} months`);
    }

    console.log(`[historical-search] user=${userId} done: ${out.length} total candidates`);
    return out;
  },
};
