import type { Fetcher, FetchedCandidate, FetcherContext } from "./types";
import { inferRepoShape } from "./repo-shape";
import { shouldSkip } from "./big-co";
import { readRunOrEnv } from "../analyzer/run-context";

// Post-training-cutoff repo discovery. The LLMs that score Replen's matches
// (Claude Opus 4.7, DeepSeek-v4, Codex) have a Jan 2026 training cutoff;
// anything before that they already "know" via training. The highest-leverage
// surfacings are repos that went 0→useful AFTER the cutoff — those are the
// ones the LLM can't recognise from prior signal alone.
//
// gh-trending only reaches back 30d. ossinsight-trending reaches 3 months
// (past_6_months / past_year return 0 rows — confirmed empirically). That
// leaves a gap: anything that emerged between roughly cutoff date and 3
// months ago. This fetcher closes that gap by hitting GitHub's Search API
// directly with `created:>YYYY-MM-DD` per language slice.
//
// Default cutoff window: 2025-09-01 → today. That's 4 months pre-cutoff +
// the full post-cutoff window. Override via REPLEN_RECENT_REPOS_SINCE.

const SINCE_DATE = process.env.REPLEN_RECENT_REPOS_SINCE ?? "2025-09-01";
// Floor — keep "real" repos but cast wider than gh-trending's implicit
// stars threshold. 200 catches things that have proven traction without
// already being on gh-trending.
const MIN_STARS = parseInt(process.env.GH_SEARCH_RECENT_MIN_STARS ?? "200", 10);
// Per-slice cap. Combined with the language fan-out, this caps the total
// surface area at PER_LANG_CAP * (MAX_LANGS + 1) candidates per run.
const PER_LANG_CAP = parseInt(process.env.GH_SEARCH_RECENT_PER_LANG ?? "10", 10);
const MAX_LANGS = 5;

// Language → GitHub search qualifier. GitHub's `language:` filter is
// case-sensitive and uses canonical names; pass-through is correct for
// the canonical forms the loader already detects (TypeScript, Python, ...).
const FALLBACK_LANGS = ["TypeScript", "Python", "Rust", "Go"];

export const ghSearchRecentFetcher: Fetcher = {
  name: "gh-search-recent",
  async run(ctx?: FetcherContext): Promise<FetchedCandidate[]> {
    const detected = (ctx?.detectedLanguages ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const langs = detected.length > 0 ? detected.slice(0, MAX_LANGS) : FALLBACK_LANGS;
    // Global slice too — anything created post-cutoff with traction,
    // regardless of language. Catches new categories of tools that don't
    // fit cleanly into the user's detected stack but might still be useful.
    const slices = ["", ...langs];
    console.log(`[gh-search-recent] since=${SINCE_DATE} slices: ${slices.map((l) => l || "all").join(",")}`);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "replen/0.1",
    };
    const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
    if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

    const out: FetchedCandidate[] = [];
    const seen = new Set<string>();

    for (const lang of slices) {
      // `fork:false archived:false` ensures we don't surface mirror repos
      // or dead projects. `sort=stars order=desc` gets the post-cutoff repos
      // with the most traction first — the same shape gh-trending uses.
      const langClause = lang ? `language:${lang} ` : "";
      const q = `${langClause}created:>${SINCE_DATE} stars:>=${MIN_STARS} fork:false archived:false`;
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_LANG_CAP}`;

      let items: Array<Record<string, unknown>> = [];
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.warn(`[gh-search-recent] ${lang || "all"}: HTTP ${res.status} ${body.slice(0, 200)}`);
          continue;
        }
        const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
        items = json.items ?? [];
      } catch (e) {
        console.warn(`[gh-search-recent] ${lang || "all"}: fetch failed: ${(e as Error).message}`);
        continue;
      }

      let kept = 0;
      for (const item of items) {
        const fullName = String(item.full_name ?? "");
        const [owner, name] = fullName.split("/");
        if (!owner || !name) continue;
        const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
        // Cross-slice de-dup: a TS repo will appear on both the TS slice and
        // the global slice. Keep the first hit, which under sort=stars desc
        // is the higher-traction surfacing.
        if (seen.has(key)) continue;
        seen.add(key);

        const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
        const verdict = shouldSkip(owner, stars);
        if (verdict.skip) continue;

        const description = String(item.description ?? "").trim();
        const createdAt = item.created_at ? new Date(String(item.created_at)) : null;
        const pushedAt = item.pushed_at ? new Date(String(item.pushed_at)) : null;
        const language = item.language ? String(item.language) : null;
        const license =
          item.license && typeof item.license === "object" && item.license !== null
            ? String((item.license as { spdx_id?: unknown }).spdx_id ?? "")
            : null;

        const topicsRaw = Array.isArray(item.topics) ? (item.topics as unknown[]).filter((t) => typeof t === "string") as string[] : [];
        out.push({
          source: lang ? `gh-search-recent:${lang}` : "gh-search-recent:all",
          sourceItemId: fullName,
          title: `${fullName} - ${description}`.slice(0, 280),
          url: `https://github.com/${fullName}`,
          githubUrl: `https://github.com/${fullName}`,
          author: owner,
          score: stars,
          // Surface created_at as the "posted at" timestamp so the recency
          // sort in pipeline.ts treats post-cutoff births correctly.
          postedAt: createdAt ?? pushedAt,
          createdAt, // true repo birth date (drives the frontier prior)
          raw: {
            owner,
            name,
            description,
            stars,
            language,
            license,
            createdAt: createdAt?.toISOString() ?? null,
            pushedAt: pushedAt?.toISOString() ?? null,
            lang,
            sinceDate: SINCE_DATE,
            topics: topicsRaw,
          },
          primaryLanguage: language,
          topics: topicsRaw,
          repoShape: inferRepoShape({ name, description, topics: topicsRaw }),
        });
        kept++;
      }
      console.log(`[gh-search-recent] ${lang || "all"}: ${items.length} hits, ${kept} kept`);
    }
    return out;
  },
};
