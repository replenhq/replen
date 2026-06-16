// Pattern A — "watch your stack" fetcher.
//
// A scouted, per-user fetcher: it reads the user's included projects, parses
// their dependencies, matches them against the vendor registry, and emits the
// recent GitHub Releases of every vendor the user actually depends on. Those
// releases become candidates in the normal inventory — but because they're
// driven by real dependency usage (not the OSS firehose), they carry a strong
// "you depend on this" signal that the inventory route honours (it bypasses
// the cosine relevance floor for a candidate whose vendor is in the scoped
// project's deps — see src/app/api/inventory/today/route.ts).
//
// Source dependency-free by design: GitHub Releases only in v1. Pure-SaaS
// changelogs (Stripe/Linear/Notion) need an RSS/HTML adapter and are a
// follow-on, not a stub here.

import type { Fetcher, FetchedCandidate } from "../types";
import { db, schema } from "../../db/client";
import { and, eq } from "drizzle-orm";
import { readRunOrEnv } from "../../analyzer/run-context";
import { vendorsForDeps, parseTechSummaryDeps, parseDepVersionNames, type StackVendor } from "./registry";
import { userToolTokens } from "../../lib/detect-tokens";

const RELEASE_WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_STACK_WINDOW_DAYS ?? "90", 10) || 90);
// Default to the single latest STABLE release per vendor — surfacing 3 point
// releases (or a stream of canaries) is noise, not signal.
const MAX_RELEASES_PER_VENDOR = Math.max(1, parseInt(process.env.REPLEN_STACK_MAX_PER_VENDOR ?? "1", 10) || 1);
// Pre-releases (canary / rc / alpha / beta / nightly) are OFF by default: a
// user on a stable line shouldn't be pinged about every Next.js canary.
const INCLUDE_PRERELEASE = process.env.REPLEN_STACK_INCLUDE_PRERELEASE === "1";
// Semver pre-release suffix sniff — GitHub's `prerelease` flag is unreliable
// across vendors, so we also reject tags with a pre-release marker after the
// version (e.g. v16.3.0-canary.44, 2.0.0-beta.1, v5-rc.0).
const PRERELEASE_TAG = /-(canary|nightly|alpha|beta|rc|pre|preview|experimental|snapshot|dev|next|insiders?)\b/i;
// Cap on DB-backed vendors (announcement_sources github_releases rows) added on
// top of the static registry, per user per run — bounds GitHub API usage.
const MAX_ANNOUNCEMENT_VENDORS = Math.max(0, parseInt(process.env.REPLEN_STACK_ANN_MAX ?? "25", 10) || 25);

type GhRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
};

export const stackWatchFetcher: Fetcher = {
  name: "stack-watch",
  async run(ctx) {
    if (!ctx?.userId) return [];
    const userId = ctx.userId;

    const projects = await db
      .select({
        slug: schema.projectProfiles.slug,
        techSummary: schema.projectProfiles.techSummary,
        depVersions: schema.projectProfiles.depVersions,
        tags: schema.projectProfiles.tags,
      })
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, userId),
        eq(schema.projectProfiles.included, true),
        eq(schema.projectProfiles.active, true),
      ));

    // Union the vendors used across all of the user's projects.
    const vendors = new Map<string, StackVendor>();
    const allDeps = new Set<string>();
    const allTags = new Set<string>();
    for (const p of projects) {
      // techSummary's deps line only ever existed for Node projects; depVersions
      // is the authoritative dep source for Python/Rust/Go repos. Union both.
      const deps = new Set([...parseTechSummaryDeps(p.techSummary), ...parseDepVersionNames(p.depVersions)]);
      for (const d of deps) allDeps.add(d);
      try {
        const t = JSON.parse(p.tags ?? "[]");
        if (Array.isArray(t)) for (const tag of t) if (typeof tag === "string") allTags.add(tag);
      } catch { /* malformed tags — skip */ }
      for (const v of vendorsForDeps(deps)) {
        vendors.set(v.id, v);
      }
    }

    // DB-backed vendors from the announcement source catalogue: github_releases
    // rows whose detect tokens hit the user's deps or tags. Platform-level
    // repos (deno, bun, supabase/supabase, redis/redis) the static registry
    // doesn't carry. Tokens that came from a DEP keep the strong stake signal
    // (the route intersects candidate topics with project deps); tag-matched
    // sources flow through normal relevance filtering instead.
    if (MAX_ANNOUNCEMENT_VENDORS > 0 && (allDeps.size > 0 || allTags.size > 0)) {
      const userTokens = userToolTokens(allDeps, allTags);
      const knownRepos = new Set([...vendors.values()].map((v) => v.githubRepo.toLowerCase()));
      const annSources = await db
        .select()
        .from(schema.announcementSources)
        .where(and(
          eq(schema.announcementSources.sourceType, "github_releases"),
          eq(schema.announcementSources.active, true),
        ));
      let added = 0;
      for (const s of annSources) {
        if (added >= MAX_ANNOUNCEMENT_VENDORS) break;
        const gh = s.sourceUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
        if (!gh) continue;
        const repo = `${gh[1]}/${gh[2].replace(/\.git$/i, "")}`;
        if (knownRepos.has(repo.toLowerCase())) continue;
        let toks: string[] = [];
        try { toks = JSON.parse(s.detectTokens ?? "[]"); } catch { /* */ }
        const matched = toks.filter((t) => userTokens.has(t));
        if (!matched.length) continue;
        knownRepos.add(repo.toLowerCase());
        added++;
        vendors.set(`ann-${s.sourceId}`, {
          id: `ann-${s.sourceId}`,
          name: s.product.replace(/\s+releases$/i, "") || s.vendor,
          depNames: matched,
          githubRepo: repo,
          ecosystem: "multi",
        });
      }
      if (added > 0) console.log(`[stack-watch] user=${userId} +${added} announcement-source vendor(s) matched by deps/tags`);
    }
    if (vendors.size === 0) return [];

    const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
    const sinceMs = Date.now() - RELEASE_WINDOW_DAYS * 24 * 3600 * 1000;

    const out: FetchedCandidate[] = [];
    for (const v of vendors.values()) {
      let releases: GhRelease[];
      try {
        releases = await fetchReleases(v.githubRepo, ghToken);
      } catch (e) {
        console.warn(`[stack-watch] user=${userId} ${v.id} (${v.githubRepo}) releases failed: ${(e as Error).message}`);
        continue;
      }
      let kept = 0;
      for (const r of releases) {
        if (r.draft) continue;
        if (!INCLUDE_PRERELEASE && (r.prerelease || PRERELEASE_TAG.test(r.tag_name))) continue;
        const pub = r.published_at ? Date.parse(r.published_at) : NaN;
        if (!Number.isFinite(pub) || pub < sinceMs) continue;
        const body = (r.body ?? "").trim();
        out.push({
          source: `stack-watch:${v.id}`,
          sourceItemId: String(r.id),
          title: `${v.name} ${r.tag_name}${r.prerelease ? " (pre-release)" : ""}`,
          url: r.html_url,
          githubUrl: `https://github.com/${v.githubRepo}`,
          author: v.name,
          score: null,
          postedAt: new Date(pub),
          raw: {
            kind: "stack-watch",
            vendorId: v.id,
            vendor: v.name,
            // The packages that tie this release to a project's manifest — the
            // route intersects these with the scoped project's deps to decide
            // it's a true dependency match.
            depNames: v.depNames,
            githubRepo: v.githubRepo,
            tag: r.tag_name,
            releaseName: r.name,
            notes: body.slice(0, 4000),
          },
          primaryLanguage: null,
          // Tag so the inventory's tag filter and the route's dep-match path
          // can recognise stack-watch candidates.
          topics: ["stack-watch", v.id, ...v.depNames.map((d) => d.toLowerCase())],
        });
        if (++kept >= MAX_RELEASES_PER_VENDOR) break;
      }
    }
    console.log(`[stack-watch] user=${userId} ${vendors.size} vendor(s) in stack → ${out.length} release candidate(s)`);
    return out;
  },
};

async function fetchReleases(repo: string, token: string | undefined): Promise<GhRelease[]> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "replen/stack-watch",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  // Fetch deeper than we keep: vendors like Next.js cut a stream of canaries
  // between stables, so the latest stable can be ~20 releases back.
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
  if (!res.ok) throw new Error(`GET releases ${repo} → ${res.status}`);
  return (await res.json()) as GhRelease[];
}
