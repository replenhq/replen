import * as cheerio from "cheerio";
import type { Fetcher, FetchedCandidate, FetcherContext } from "./types";
import { shouldSkip } from "./big-co";

// gh-trending URL paths use lowercase, hyphenated slugs. Special-case the
// ones GitHub doesn't auto-derive from a `.toLowerCase()`.
const LANG_SLUG_OVERRIDES: Record<string, string> = {
  "C++": "c++",
  "C#": "c%23",
  "F#": "f%23",
  "Objective-C": "objective-c",
  "Vim Script": "vim-script",
  "Vim script": "vim-script",
  "Jupyter Notebook": "jupyter-notebook",
  "Shell": "shell",
};
function langToSlug(lang: string): string {
  return LANG_SLUG_OVERRIDES[lang] ?? lang.toLowerCase().replace(/\s+/g, "-");
}

// Always include the global trending page (lang=""). The other slices are
// derived from the user's detected languages, or fall back to a sensible
// default if the user hasn't connected a PAT yet.
const FALLBACK_LANGS = ["typescript", "python", "rust", "go"];
// Cap per language so trending doesn't dominate the run. Applied AFTER the
// daily+weekly+monthly union so we pick the freshest N per language across
// all three windows, not N from each.
const PER_LANG_CAP = parseInt(process.env.GH_TRENDING_PER_LANG ?? "8", 10);
// Hard ceiling on language slices - without this a polyglot user could
// trigger 10+ trending fetches per run.
const MAX_LANGS = 5;
// Trending windows. `daily` is what's hot today, `weekly` catches anything
// that trended in the last 7 days but might've dropped off today's chart,
// `monthly` captures sustained-attention repos. We try them in this order
// and stop once PER_LANG_CAP is filled — so "today's hot stuff" still wins,
// but we top up from older windows when daily is sparse.
const WINDOWS = ["daily", "weekly", "monthly"] as const;

export const ghTrendingFetcher: Fetcher = {
  name: "gh-trending",
  async run(ctx?: FetcherContext) {
    const detected = (ctx?.detectedLanguages ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(langToSlug);
    const langSet = new Set<string>(["", ...(detected.length > 0 ? detected : FALLBACK_LANGS)]);
    const langs = [...langSet].slice(0, MAX_LANGS + 1); // +1 for the "" global slice
    console.log(`[gh-trending] slices: ${langs.map((l) => l || "all").join(",")}`);

    const out: FetchedCandidate[] = [];
    for (const lang of langs) {
      // Pull all three windows in parallel, then score by window-membership.
      // A repo on daily+weekly+monthly is "viral AND sustained" = ideal.
      // A repo on weekly+monthly = "proven, not just today's hype" = goldilocks.
      // A repo on daily only = "today's spike, probably untested" = lowest.
      // This inverts the previous priority (daily-first) because daily alone
      // optimises for star-velocity, which correlates with hype more than
      // utility. See docs/active-scouting-plan.md for the broader rethink.
      const perWindow = await Promise.all(
        WINDOWS.map(async (since) => {
          const url = `https://github.com/trending/${lang}?since=${since}`;
          const res = await fetch(url, { headers: { "user-agent": "replen/0.1" } });
          if (!res.ok) {
            console.warn(`[gh-trending] ${lang || "all"}/${since} -> ${res.status}`);
            return [] as Array<{ owner: string; name: string; desc: string; stars: number | null }>;
          }
          const html = await res.text();
          const $ = cheerio.load(html);
          const rows: Array<{ owner: string; name: string; desc: string; stars: number | null }> = [];
          $("article.Box-row").each((_, el) => {
            const repoPath = $(el).find("h2 a").attr("href")?.trim();
            if (!repoPath) return;
            const [, owner, name] = repoPath.split("/");
            if (!owner || !name) return;
            const desc = $(el).find("p").first().text().trim();
            const starsText = $(el).find("a.Link--muted").first().text().trim();
            const stars = parseInt(starsText.replace(/[^\d]/g, ""), 10) || null;
            rows.push({ owner, name, desc, stars });
          });
          return rows;
        }),
      );

      // Build per-repo membership map: which windows did it appear on, and
      // capture the metadata once (any window's row has the same desc/stars
      // within a few hours).
      type Entry = { owner: string; name: string; desc: string; stars: number | null; windows: Set<string> };
      const byKey = new Map<string, Entry>();
      WINDOWS.forEach((since, idx) => {
        for (const r of perWindow[idx]) {
          const key = `${r.owner}/${r.name}`;
          const existing = byKey.get(key);
          if (existing) {
            existing.windows.add(since);
          } else {
            byKey.set(key, { ...r, windows: new Set([since]) });
          }
        }
      });

      // Apply big-co skip ONCE per repo (not per window). Score by membership
      // pattern, break ties by star count.
      const scored: Array<{ entry: Entry; score: number }> = [];
      for (const entry of byKey.values()) {
        const verdict = shouldSkip(entry.owner, entry.stars);
        if (verdict.skip) {
          console.log(`[gh-trending] skip ${entry.owner}/${entry.name}: ${verdict.reason}`);
          continue;
        }
        // Score: 3 if on all three windows; +2 for the weekly+monthly pair
        // (the goldilocks band); +1 for monthly-or-weekly singletons; +0 for
        // daily-only. Higher = better signal.
        const hasD = entry.windows.has("daily");
        const hasW = entry.windows.has("weekly");
        const hasM = entry.windows.has("monthly");
        let score = 0;
        if (hasD && hasW && hasM) score = 4;
        else if (hasW && hasM) score = 3;
        else if (hasM) score = 2;
        else if (hasW) score = 2;
        else if (hasD) score = 1;
        scored.push({ entry, score });
      }

      // Sort by membership score desc, then stars desc as tiebreak.
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.entry.stars ?? 0) - (a.entry.stars ?? 0);
      });

      const picked = scored.slice(0, PER_LANG_CAP);
      for (const { entry, score } of picked) {
        out.push({
          source: lang ? `gh-trending:${lang}` : "gh-trending:all",
          sourceItemId: `${entry.owner}/${entry.name}`,
          title: `${entry.owner}/${entry.name} - ${entry.desc}`,
          url: `https://github.com/${entry.owner}/${entry.name}`,
          githubUrl: `https://github.com/${entry.owner}/${entry.name}`,
          author: entry.owner,
          score: entry.stars,
          postedAt: new Date(),
          // membership stored so the source-ranking layer can boost
          // weekly+monthly hits over daily-only ones if we want to.
          raw: {
            owner: entry.owner,
            name: entry.name,
            desc: entry.desc,
            stars: entry.stars,
            lang,
            windows: [...entry.windows].sort(),
            membershipScore: score,
          },
        });
      }
      console.log(
        `[gh-trending] ${lang || "all"}: ${byKey.size} unique across ${WINDOWS.length} windows, kept top ${picked.length}`,
      );
    }
    return out;
  },
};
