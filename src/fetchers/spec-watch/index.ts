// Pattern B — "watch what regulates your code" fetcher.
//
// A scouted per-user fetcher (sibling of stack-watch): reads the user's
// projects, finds which standards their dependencies give them a stake in
// (EIPs/ERCs for web3 deps, TC39 for JS/TS, Chrome Status for frontend), and
// emits the recent changes to those standards as candidates. The inventory
// route recognises a spec-watch candidate whose signal packages are in the
// scoped project's deps as a stake match — it bypasses the relevance floor and
// leads the footnote with "a standard your code implements just changed".

import type { Fetcher, FetchedCandidate } from "../types";
import { db, schema } from "../../db/client";
import { and, eq } from "drizzle-orm";
import { readRunOrEnv } from "../../analyzer/run-context";
import { specSourcesForDeps, type SpecSource } from "./registry";
import { parseTechSummaryDeps, parseDepVersionNames } from "../stack-watch/registry";
import { fetchRecentForSource } from "./sources";

const WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_SPEC_WINDOW_DAYS ?? "30", 10) || 30);
const MAX_ITEMS_PER_SOURCE = Math.max(1, parseInt(process.env.REPLEN_SPEC_MAX_PER_SOURCE ?? "5", 10) || 5);

export const specWatchFetcher: Fetcher = {
  name: "spec-watch",
  async run(ctx) {
    if (!ctx?.userId) return [];
    const userId = ctx.userId;

    const projects = await db
      .select({ techSummary: schema.projectProfiles.techSummary, depVersions: schema.projectProfiles.depVersions })
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, userId),
        eq(schema.projectProfiles.included, true),
        eq(schema.projectProfiles.active, true),
      ));

    // Union the spec sources the user's projects have a stake in. Dep names come
    // from tech_summary (Node) AND depVersions (Python/Rust/Go).
    const sources = new Map<string, SpecSource>();
    for (const p of projects) {
      const deps = new Set([...parseTechSummaryDeps(p.techSummary), ...parseDepVersionNames(p.depVersions)]);
      for (const s of specSourcesForDeps(deps)) {
        sources.set(s.id, s);
      }
    }
    if (sources.size === 0) return [];

    const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
    const sinceMs = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;

    const out: FetchedCandidate[] = [];
    for (const s of sources.values()) {
      let items;
      try {
        items = await fetchRecentForSource(s, { sinceMs, ghToken, maxItems: MAX_ITEMS_PER_SOURCE });
      } catch (e) {
        console.warn(`[spec-watch] user=${userId} ${s.id} failed: ${(e as Error).message}`);
        continue;
      }
      for (const it of items) {
        out.push({
          source: `spec-watch:${s.id}`,
          sourceItemId: it.sourceItemId,
          title: it.title,
          url: it.url,
          githubUrl: it.githubUrl,
          author: s.name,
          score: null,
          postedAt: it.postedAt,
          raw: {
            kind: "spec-watch",
            specId: s.id,
            specName: s.name,
            specKind: s.kind,
            // The packages that tie this standard to a project's manifest — the
            // route intersects these with the scoped project's deps.
            depSignals: s.depSignals,
            langSignals: s.langSignals,
            summary: it.summary,
          },
          primaryLanguage: null,
          // Tag with the signal packages so the route's stake-match path and the
          // tag filter recognise spec-watch candidates.
          topics: ["spec-watch", s.id, s.kind, ...s.depSignals.map((d) => d.toLowerCase()), ...s.langSignals],
        });
      }
    }
    console.log(`[spec-watch] user=${userId} ${sources.size} source(s) in scope → ${out.length} spec-change candidate(s)`);
    return out;
  },
};
