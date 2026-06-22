// CURATED source — the candidate-supply quality lever. Raw trending measures
// popularity, not fit; a human curator filters for "genuinely good/interesting".
// This lens ingests each seeded curator's RECENT PUBLIC GitHub stars (public data;
// "what do respected engineers star" is a recognised discovery mechanism), tagged
// source=curated:<handle> so each curator's keeper-rate is measured + learned over
// time. Seed: seeds/curators.json (a starter; the maintained curator network is
// operational — newsletters/awesome-lists/more curators slot in via new types here).
//
// Mechanical, no LLM. One bad curator handle never kills the lens (per-curator
// try/catch); the whole run is still hard-capped by FETCHER_TIMEOUT_MS in index.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetcher, FetchedCandidate } from "./types";
import { readRunOrEnv } from "../analyzer/run-context";

type Curator = { type: string; handle?: string; note?: string };
type StarredItem = {
  starred_at?: string;
  repo?: { full_name?: string; html_url?: string; description?: string | null; language?: string | null; topics?: string[]; stargazers_count?: number; archived?: boolean };
};

const RECENCY_DAYS = Math.max(1, parseInt(process.env.REPLEN_CURATED_RECENCY_DAYS ?? "60", 10) || 60);
const PER_CURATOR = Math.min(50, Math.max(1, parseInt(process.env.REPLEN_CURATED_PER_CURATOR ?? "15", 10) || 15));

function loadCurators(): Curator[] {
  try {
    const j = JSON.parse(readFileSync(join(process.cwd(), "seeds", "curators.json"), "utf8")) as { curators?: Curator[] };
    return Array.isArray(j.curators) ? j.curators : [];
  } catch { return []; }
}

export const curatedFetcher: Fetcher = {
  name: "curated",
  async run() {
    const curators = loadCurators().filter((c) => c.type === "github-stars" && c.handle);
    if (curators.length === 0) return [];
    const token = readRunOrEnv("githubToken", "GITHUB_TOKEN");
    const headers: Record<string, string> = { "user-agent": "replen/0.1", accept: "application/vnd.github.star+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const horizon = Date.now() - RECENCY_DAYS * 24 * 3600 * 1000;
    const out: FetchedCandidate[] = [];
    const seen = new Set<string>();

    // Curators pulled concurrently; one failing handle is swallowed (non-fatal).
    await Promise.all(curators.map(async (c) => {
      try {
        const res = await fetch(
          `https://api.github.com/users/${encodeURIComponent(c.handle!)}/starred?sort=created&direction=desc&per_page=${PER_CURATOR}`,
          { headers, signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) return;
        const items = (await res.json()) as StarredItem[];
        if (!Array.isArray(items)) return;
        for (const it of items) {
          const repo = it.repo;
          if (!repo?.full_name || !repo.html_url || repo.archived) continue;
          const at = it.starred_at ? Date.parse(it.starred_at) : NaN;
          if (Number.isFinite(at) && at < horizon) continue; // only FRESH curation
          const fn = repo.full_name.toLowerCase();
          if (seen.has(fn)) continue;
          seen.add(fn);
          out.push({
            source: `curated:${c.handle}`,
            sourceItemId: repo.full_name,
            title: repo.full_name,
            url: repo.html_url,
            githubUrl: repo.html_url,
            author: c.handle ?? null,
            score: repo.stargazers_count ?? null,
            postedAt: Number.isFinite(at) ? new Date(at) : null,
            raw: it,
            primaryLanguage: repo.language ?? null,
            topics: Array.isArray(repo.topics) ? repo.topics : null,
          });
        }
      } catch { /* one curator failing is non-fatal */ }
    }));
    return out;
  },
};
