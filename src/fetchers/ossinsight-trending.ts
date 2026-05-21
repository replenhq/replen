import type { Fetcher, FetchedCandidate, FetcherContext } from "./types";
import { shouldSkip } from "./big-co";
import { inferRepoShape } from "./repo-shape";

// OSSInsight (run by PingCAP) exposes a public trending API that goes back
// further than github.com/trending. github.com's `?since=monthly` is the
// longest window scrapeable from the trending page itself; OSSInsight's
// /v1/trends/repos/ endpoint exposes `past_3_months`, which is the band we
// want — "sustained attention" rather than "spiking today".
//
// Why this is a separate fetcher rather than another window inside
// gh-trending.ts:
//   1. Different transport: JSON API vs HTML scrape (different failure modes)
//   2. Different signal: past_3_months is *long-haul* trending, distinct from
//      daily/weekly/monthly which all measure recent attention
//   3. We want to be able to toggle it independently if the API goes flaky
const API_BASE = "https://api.ossinsight.io/v1/trends/repos/";

// OSSinsight rejects 6-month / 1-year period names (returns 0 rows). The
// useful long-haul window is past_3_months — that's our new addition over
// gh-trending. We also pull past_month as a check / boost source: a repo
// that hits *both* gh-trending monthly AND OSSinsight past_month is a
// strong signal even before scoring.
const PERIODS = ["past_3_months", "past_month"] as const;

const FALLBACK_LANGS = ["TypeScript", "Python", "Rust", "Go"];
// Per language cap — combined across both periods. Same default as
// gh-trending so the source mix stays balanced.
const PER_LANG_CAP = parseInt(process.env.OSSINSIGHT_PER_LANG ?? "8", 10);
const MAX_LANGS = 5;

type OssRow = {
  repo_id: string;
  repo_name: string; // "owner/name"
  primary_language: string | null;
  description: string | null;
  stars: string | null;
  forks: string | null;
  total_score: string | null;
};

export const ossinsightTrendingFetcher: Fetcher = {
  name: "ossinsight-trending",
  async run(ctx?: FetcherContext) {
    const detected = (ctx?.detectedLanguages ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // OSSinsight uses canonical language names (TypeScript, Python) not
    // the slug form gh-trending wants — pass through as-is.
    const langs = detected.length > 0 ? detected.slice(0, MAX_LANGS) : FALLBACK_LANGS;
    // Always include the global slice (no language filter) so we don't
    // miss a high-signal repo just because its primary_language isn't in
    // the user's detected set.
    const langSet = new Set<string>(["", ...langs]);
    const allLangs = [...langSet].slice(0, MAX_LANGS + 1);
    console.log(`[ossinsight] slices: ${allLangs.map((l) => l || "all").join(",")}`);

    const out: FetchedCandidate[] = [];
    for (const lang of allLangs) {
      // Pull both periods in parallel — same membership-scoring trick as
      // gh-trending. A repo appearing on past_3_months AND past_month is
      // "consistently rising", not just "this month's bump".
      const perPeriod = await Promise.all(
        PERIODS.map(async (period) => {
          const url = lang
            ? `${API_BASE}?period=${period}&language=${encodeURIComponent(lang)}`
            : `${API_BASE}?period=${period}`;
          try {
            const res = await fetch(url, {
              headers: { "user-agent": "replen/0.1", accept: "application/json" },
            });
            if (!res.ok) {
              console.warn(`[ossinsight] ${lang || "all"}/${period} -> ${res.status}`);
              return [] as OssRow[];
            }
            const json = (await res.json()) as { data?: { rows?: OssRow[] } };
            return json.data?.rows ?? [];
          } catch (e) {
            console.warn(`[ossinsight] fetch failed for ${lang || "all"}/${period}: ${(e as Error).message}`);
            return [];
          }
        }),
      );

      // Membership map: which periods did each repo appear in?
      type Entry = {
        owner: string;
        name: string;
        desc: string;
        stars: number | null;
        primaryLang: string | null;
        ossScore: number | null;
        periods: Set<string>;
      };
      const byKey = new Map<string, Entry>();
      PERIODS.forEach((period, idx) => {
        for (const r of perPeriod[idx]) {
          const [owner, name] = (r.repo_name ?? "").split("/");
          if (!owner || !name) continue;
          const key = `${owner}/${name}`;
          const stars = r.stars ? parseInt(r.stars, 10) : null;
          const ossScore = r.total_score ? parseFloat(r.total_score) : null;
          const existing = byKey.get(key);
          if (existing) {
            existing.periods.add(period);
          } else {
            byKey.set(key, {
              owner,
              name,
              desc: r.description ?? "",
              stars,
              primaryLang: r.primary_language,
              ossScore,
              periods: new Set([period]),
            });
          }
        }
      });

      // Same big-co skip + membership scoring as gh-trending. We bias
      // toward repos that hit both windows.
      const scored: Array<{ entry: Entry; score: number }> = [];
      for (const entry of byKey.values()) {
        const verdict = shouldSkip(entry.owner, entry.stars);
        if (verdict.skip) {
          continue;
        }
        const has3m = entry.periods.has("past_3_months");
        const hasM = entry.periods.has("past_month");
        // Both periods = sustained AND current = highest signal.
        // 3m only = "long-haul climber, may have plateaued" — still good.
        // month only = "just hit OSSinsight's monthly view" — equivalent
        // to gh-trending's monthly, slight redundancy with that source.
        const score = has3m && hasM ? 3 : has3m ? 2 : hasM ? 1 : 0;
        scored.push({ entry, score });
      }
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Tiebreak by OSSinsight's own total_score (combines stars, forks,
        // PRs, pushes) — a richer signal than stars alone.
        return (b.entry.ossScore ?? 0) - (a.entry.ossScore ?? 0);
      });
      const picked = scored.slice(0, PER_LANG_CAP);

      for (const { entry, score } of picked) {
        out.push({
          source: lang ? `ossinsight-trending:${lang}` : "ossinsight-trending:all",
          sourceItemId: `${entry.owner}/${entry.name}`,
          title: `${entry.owner}/${entry.name} - ${entry.desc}`,
          url: `https://github.com/${entry.owner}/${entry.name}`,
          githubUrl: `https://github.com/${entry.owner}/${entry.name}`,
          author: entry.owner,
          score: entry.stars,
          postedAt: new Date(),
          raw: {
            owner: entry.owner,
            name: entry.name,
            desc: entry.desc,
            stars: entry.stars,
            primaryLanguage: entry.primaryLang,
            ossScore: entry.ossScore,
            lang,
            periods: [...entry.periods].sort(),
            membershipScore: score,
          },
          // Pipeline v2 / Sprint 1 inventory tagging. OSSInsight gives
          // us the canonical primary language ("TypeScript", "Python")
          // directly. Topics aren't in this endpoint — enrichment pass
          // later fills them. Shape inferred from name + description.
          primaryLanguage: entry.primaryLang || lang || null,
          topics: null,
          repoShape: inferRepoShape({ name: entry.name, description: entry.desc }),
        });
      }
      console.log(
        `[ossinsight] ${lang || "all"}: ${byKey.size} unique across ${PERIODS.length} periods, kept top ${picked.length}`,
      );
    }
    return out;
  },
};
