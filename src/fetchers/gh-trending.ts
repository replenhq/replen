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
// Cap per language so trending doesn't dominate the run.
const PER_LANG_CAP = parseInt(process.env.GH_TRENDING_PER_LANG ?? "8", 10);
// Hard ceiling on language slices — without this a polyglot user could
// trigger 10+ trending fetches per run.
const MAX_LANGS = 5;

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
      const url = `https://github.com/trending/${lang}?since=daily`;
      const res = await fetch(url, { headers: { "user-agent": "replen/0.1" } });
      if (!res.ok) {
        console.warn(`[gh-trending] ${lang || "all"} -> ${res.status}`);
        continue;
      }
      const html = await res.text();
      const $ = cheerio.load(html);
      let kept = 0;
      $("article.Box-row").each((_, el) => {
        if (kept >= PER_LANG_CAP) return;
        const repoPath = $(el).find("h2 a").attr("href")?.trim();
        if (!repoPath) return;
        const [, owner, name] = repoPath.split("/");
        if (!owner || !name) return;
        const desc = $(el).find("p").first().text().trim();
        const starsText = $(el).find("a.Link--muted").first().text().trim();
        const stars = parseInt(starsText.replace(/[^\d]/g, ""), 10) || null;
        // Drop big-co accounts and over-established repos before they consume
        // any downstream triage tokens.
        const verdict = shouldSkip(owner, stars);
        if (verdict.skip) {
          console.log(`[gh-trending] skip ${owner}/${name}: ${verdict.reason}`);
          return;
        }
        out.push({
          source: lang ? `gh-trending:${lang}` : "gh-trending:all",
          sourceItemId: `${owner}/${name}`,
          title: `${owner}/${name} — ${desc}`,
          url: `https://github.com/${owner}/${name}`,
          githubUrl: `https://github.com/${owner}/${name}`,
          author: owner,
          score: stars,
          postedAt: new Date(),
          raw: { owner, name, desc, stars, lang },
        });
        kept++;
      });
    }
    return out;
  },
};
