// Pattern C — "watch the health of what you build on".
//
// A scouted per-user fetcher that watches the upstreams a project depends on
// and raises a candidate when one looks risky:
//   C11 dep maintainer health  — a direct dep that's gone stale / dead / archived
//   C12 issue mirroring        — a high-engagement open issue others are hitting in a dep
//   C13 status / SLA           — an active incident on a managed service the project uses
//
// All three are "stake" signals (the project depends on the thing), so the
// inventory route treats them like Pattern A/B matches: they bypass the
// relevance floor and lead the footnote.
//
// Honest scope: C14 (correlating a vendor outage with YOUR error rates) and the
// log-driven half of C12 need the user's error logs, which Replen doesn't
// ingest yet — that's a separate data pipeline, deliberately not stubbed here.

import type { Fetcher, FetchedCandidate } from "../types";
import { db, schema } from "../../db/client";
import { and, eq } from "drizzle-orm";
import { readRunOrEnv } from "../../analyzer/run-context";
import { probeDepHealth } from "../../projects/dep-health";
import type { ProjectDep, DepEcosystem } from "../../projects/manifest-parser";
import { parseTechSummaryDeps } from "../stack-watch/registry";
import { statusVendorsForDeps } from "./status-registry";

const MAX_DEPS_PROBED = Math.max(1, parseInt(process.env.REPLEN_HEALTH_MAX_DEPS ?? "30", 10) || 30);
const MAX_ISSUE_REPOS = Math.max(0, parseInt(process.env.REPLEN_HEALTH_ISSUE_REPOS ?? "6", 10) || 6);
const ISSUE_REACTION_MIN = Math.max(1, parseInt(process.env.REPLEN_HEALTH_ISSUE_REACTIONS ?? "10", 10) || 10);
const ISSUE_WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_HEALTH_ISSUE_WINDOW_DAYS ?? "60", 10) || 60);
const PROBE_CONCURRENCY = 5;
// 'stale' (9-18mo no push) is too noisy — lots of healthy, complete libraries
// trip it. Off by default; surface only 'dead' (18mo+) and 'archived'.
const SURFACE_STALE = process.env.REPLEN_HEALTH_SURFACE_STALE === "1";
// A 'dead'-by-push-date verdict on a very popular library is usually a
// false positive — the lib is COMPLETE, not abandoned (e.g. clsx). Popularity
// is social proof of continued viability; abandonment risk is real for obscure
// deps, not battle-tested ones. Skip 'dead' above this star count. ('archived'
// is always surfaced — that's the maintainer explicitly saying it's done.)
const DEAD_STAR_CEILING = Math.max(0, parseInt(process.env.REPLEN_HEALTH_DEAD_STAR_CEILING ?? "5000", 10) || 5000);

export const healthWatchFetcher: Fetcher = {
  name: "health-watch",
  async run(ctx) {
    if (!ctx?.userId) return [];
    const userId = ctx.userId;

    const projects = await db
      .select({ techSummary: schema.projectProfiles.techSummary })
      .from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, userId),
        eq(schema.projectProfiles.included, true),
        eq(schema.projectProfiles.active, true),
      ));

    // Collect distinct deps across projects, with an inferred ecosystem.
    const depByName = new Map<string, ProjectDep>();
    const allDepNames = new Set<string>();
    for (const p of projects) {
      const ecosystem = inferEcosystem(p.techSummary);
      for (const name of parseTechSummaryDeps(p.techSummary)) {
        allDepNames.add(name);
        if (!depByName.has(name)) {
          depByName.set(name, { name, version: "*", ecosystem, kind: "runtime" });
        }
      }
    }
    if (depByName.size === 0) return [];

    const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
    const out: FetchedCandidate[] = [];

    // ── C11: dep maintainer health ────────────────────────────────────────
    const deps = [...depByName.values()].slice(0, MAX_DEPS_PROBED);
    const health = await mapWithConcurrency(deps, PROBE_CONCURRENCY, (d) =>
      probeDepHealth(d).catch(() => null),
    );
    const resolvedRepos: Array<{ depName: string; repo: string }> = [];
    for (const h of health) {
      if (!h) continue;
      if (h.githubFullName) resolvedRepos.push({ depName: h.depName, repo: h.githubFullName });
      // Quality gate (cuts false positives like a complete-but-quiet utility):
      //   archived → always (definitive)
      //   dead     → only if not a very popular "probably complete" lib
      //   stale    → off by default (too noisy)
      const surfaceVerdict =
        h.verdict === "archived" ||
        (h.verdict === "dead" && (h.stars ?? 0) < DEAD_STAR_CEILING) ||
        (h.verdict === "stale" && SURFACE_STALE);
      if (surfaceVerdict) {
        out.push({
          source: `health-watch:dep-${h.verdict}`,
          sourceItemId: `${h.depName}-${h.verdict}`,
          title: `${h.depName} looks ${h.verdict} — ${h.verdictReason}`,
          url: h.githubFullName ? `https://github.com/${h.githubFullName}` : `https://www.npmjs.com/package/${h.depName}`,
          githubUrl: h.githubFullName ? `https://github.com/${h.githubFullName}` : null,
          author: "health-watch",
          score: h.stars,
          postedAt: h.lastPushIso ? new Date(h.lastPushIso) : null,
          raw: {
            kind: "health-watch",
            subkind: "dep-health",
            depName: h.depName,
            verdict: h.verdict,
            reason: h.verdictReason,
            githubFullName: h.githubFullName,
            daysSinceLastPush: h.daysSinceLastPush,
            archived: h.archived,
          },
          primaryLanguage: null,
          topics: ["health-watch", "dep-health", h.verdict, h.depName.toLowerCase()],
        });
      }
    }

    // ── C12: issue mirroring — high-engagement open issues in your deps ────
    const issueRepos = resolvedRepos.slice(0, MAX_ISSUE_REPOS);
    const issueSinceMs = Date.now() - ISSUE_WINDOW_DAYS * 24 * 3600 * 1000;
    const issueResults = await mapWithConcurrency(issueRepos, PROBE_CONCURRENCY, async ({ depName, repo }) => {
      try {
        return { depName, repo, issues: await fetchHotIssues(repo, ghToken, issueSinceMs) };
      } catch {
        return { depName, repo, issues: [] as HotIssue[] };
      }
    });
    for (const r of issueResults) {
      for (const iss of r.issues) {
        out.push({
          source: "health-watch:dep-issue",
          sourceItemId: `issue-${r.repo}-${iss.number}`,
          title: `${r.depName}: others are hitting "${iss.title.slice(0, 80)}" (${iss.reactions}👍)`,
          url: iss.url,
          githubUrl: `https://github.com/${r.repo}`,
          author: "health-watch",
          score: iss.reactions,
          postedAt: iss.createdAt,
          raw: {
            kind: "health-watch",
            subkind: "dep-issue",
            depName: r.depName,
            githubFullName: r.repo,
            issueNumber: iss.number,
            reactions: iss.reactions,
            comments: iss.comments,
          },
          primaryLanguage: null,
          topics: ["health-watch", "dep-issue", r.depName.toLowerCase()],
        });
      }
    }

    // ── C13: status / SLA — active incidents on managed services you use ──
    const statusVendors = statusVendorsForDeps(allDepNames);
    const statusResults = await mapWithConcurrency(statusVendors, PROBE_CONCURRENCY, async (v) => {
      try {
        return { v, incidents: await fetchUnresolvedIncidents(v.statusHost) };
      } catch {
        return { v, incidents: [] as Incident[] };
      }
    });
    for (const s of statusResults) {
      for (const inc of s.incidents) {
        out.push({
          source: "health-watch:status",
          sourceItemId: `incident-${s.v.id}-${inc.id}`,
          title: `${s.v.name} incident: ${inc.name} (${inc.impact})`,
          url: inc.url ?? `https://${s.v.statusHost}`,
          githubUrl: null,
          author: s.v.name,
          score: null,
          postedAt: inc.startedAt,
          raw: {
            kind: "health-watch",
            subkind: "status",
            vendor: s.v.name,
            vendorId: s.v.id,
            depSignals: s.v.depSignals,
            impact: inc.impact,
            status: inc.status,
          },
          primaryLanguage: null,
          topics: ["health-watch", "status", s.v.id, ...s.v.depSignals.map((d) => d.toLowerCase())],
        });
      }
    }

    console.log(`[health-watch] user=${userId} ${depByName.size} deps → ${out.length} candidate(s) (health/issue/status)`);
    return out;
  },
};

function inferEcosystem(techSummary: string | null): DepEcosystem {
  const s = (techSummary ?? "").toLowerCase();
  if (s.startsWith("python")) return "python";
  if (s.startsWith("rust") || s.includes("cargo")) return "cargo";
  if (s.startsWith("go ")) return "go";
  return "npm";
}

type HotIssue = { number: number; title: string; url: string; reactions: number; comments: number; createdAt: Date | null };

async function fetchHotIssues(repo: string, token: string | undefined, sinceMs: number): Promise<HotIssue[]> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "replen/health-watch",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&sort=reactions&direction=desc&per_page=5`,
    { headers },
  );
  if (!res.ok) throw new Error(`GET issues ${repo} → ${res.status}`);
  const raw = (await res.json()) as Array<{
    number: number; title: string; html_url: string; created_at: string; comments: number;
    pull_request?: unknown; reactions?: { total_count?: number };
  }>;
  const out: HotIssue[] = [];
  for (const i of raw) {
    if (i.pull_request) continue; // issues endpoint includes PRs
    const reactions = i.reactions?.total_count ?? 0;
    const createdMs = Date.parse(i.created_at);
    if (reactions < ISSUE_REACTION_MIN) continue;
    if (Number.isFinite(createdMs) && createdMs < sinceMs) continue; // keep recent only
    out.push({
      number: i.number,
      title: i.title,
      url: i.html_url,
      reactions,
      comments: i.comments ?? 0,
      createdAt: Number.isFinite(createdMs) ? new Date(createdMs) : null,
    });
    if (out.length >= 2) break; // at most 2 per repo
  }
  return out;
}

type Incident = { id: string; name: string; impact: string; status: string; url: string | null; startedAt: Date | null };

async function fetchUnresolvedIncidents(host: string): Promise<Incident[]> {
  const res = await fetch(`https://${host}/api/v2/incidents/unresolved.json`, {
    headers: { "user-agent": "replen/health-watch", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET incidents ${host} → ${res.status}`);
  const data = (await res.json()) as {
    incidents?: Array<{ id: string; name: string; impact: string; status: string; shortlink?: string; started_at?: string }>;
  };
  return (data.incidents ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    impact: i.impact,
    status: i.status,
    url: i.shortlink ?? null,
    startedAt: i.started_at ? new Date(i.started_at) : null,
  }));
}

// Small bounded-concurrency map (no deps). Preserves input order.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
