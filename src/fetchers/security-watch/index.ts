// Pattern C (security) — "watch for vulnerabilities in what you depend on".
//
// A scouted per-user fetcher that maps each project's direct dependencies to
// known security advisories via osv.dev (the OSS Vulnerability database — free,
// no auth, aggregates GitHub Advisory DB + others). When a dep the user depends
// on has a recent HIGH/CRITICAL advisory, that's a stake signal (you depend on
// the thing), so the inventory route treats it like Pattern A/B/C matches: it
// bypasses the relevance floor and leads the footnote.
//
// This is the "a CVE shows up next time you open the project" signal.
// Coarse first cut: we match by package name + ecosystem (not exact installed
// version) and gate on severity + recency. Dep names come from BOTH the
// tech_summary deps line (Node) and the agent-reported depVersions map (the
// authoritative source for Python/Rust/Go). Refining to affected version ranges
// (so a patched project stays quiet) is a follow-up — depVersions now carries
// the pinned versions to make that possible.

import type { Fetcher, FetchedCandidate } from "../types";
import { db, schema } from "../../db/client";
import { and, eq } from "drizzle-orm";
import type { DepEcosystem } from "../../projects/manifest-parser";
import { parseTechSummaryDeps, parseDepVersionNames } from "../stack-watch/registry";

const WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_SECURITY_WINDOW_DAYS ?? "180", 10) || 180);
const MAX_DEPS = Math.max(1, parseInt(process.env.REPLEN_SECURITY_MAX_DEPS ?? "60", 10) || 60);
const MAX_ADVISORIES = Math.max(1, parseInt(process.env.REPLEN_SECURITY_MAX ?? "12", 10) || 12);
// Minimum severity to surface. Security noise is worse than other noise (it
// reads as urgent), so default to HIGH+ — the advisories you'd actually act on.
const MIN_SEVERITY = (process.env.REPLEN_SECURITY_MIN_SEVERITY ?? "HIGH").toUpperCase();
const FETCH_CONCURRENCY = 6;
// Bound on advisory-detail fetches per run, so a project with many flagged deps
// can't blow the osv.dev request budget.
const MAX_DETAIL_FETCHES = 80;

const SEVERITY_RANK: Record<string, number> = { LOW: 1, MODERATE: 2, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export const securityWatchFetcher: Fetcher = {
  name: "security-watch",
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

    // Distinct deps with an inferred ecosystem (first project to claim a dep
    // name sets its ecosystem — good enough; a dep name is rarely cross-eco).
    const depEco = new Map<string, DepEcosystem>();
    for (const p of projects) {
      const eco = inferEcosystem(p.techSummary);
      // Union tech_summary deps (Node) with depVersions names (Python/Rust/Go).
      for (const name of new Set([...parseTechSummaryDeps(p.techSummary), ...parseDepVersionNames(p.depVersions)])) {
        if (!depEco.has(name)) depEco.set(name, eco);
      }
    }
    if (depEco.size === 0) return [];

    const deps = [...depEco.entries()].slice(0, MAX_DEPS);
    const sinceMs = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
    const minRank = SEVERITY_RANK[MIN_SEVERITY] ?? 3;

    // Stage 1: one batch query → vuln IDs per dep (with a `modified` date we can
    // pre-filter on before paying for detail fetches).
    const batched = await osvQueryBatch(deps.map(([name, eco]) => ({ name, ecosystem: osvEcosystem(eco) })));

    // Collect candidate (vulnId → depName) keyed by vulnId so a CVE that hits
    // two of your deps surfaces once. Pre-filter by `modified` within window.
    const vulnToDep = new Map<string, string>();
    for (let i = 0; i < deps.length; i++) {
      const [depName] = deps[i];
      for (const v of batched[i] ?? []) {
        const modMs = v.modified ? Date.parse(v.modified) : NaN;
        if (Number.isFinite(modMs) && modMs < sinceMs) continue; // stale advisory
        if (!vulnToDep.has(v.id)) vulnToDep.set(v.id, depName);
      }
    }
    if (vulnToDep.size === 0) {
      console.log(`[security-watch] user=${userId} ${depEco.size} deps → 0 recent advisories`);
      return [];
    }

    // Stage 2: fetch advisory details (severity, summary, dates, refs) for the
    // recent ones, bounded.
    const ids = [...vulnToDep.keys()].slice(0, MAX_DETAIL_FETCHES);
    const details = await mapWithConcurrency(ids, FETCH_CONCURRENCY, (id) => osvVuln(id).catch(() => null));

    const out: FetchedCandidate[] = [];
    for (const d of details) {
      if (!d) continue;
      const sev = severityOf(d);
      if ((SEVERITY_RANK[sev] ?? 0) < minRank) continue;
      const publishedMs = d.published ? Date.parse(d.published) : NaN;
      const withinWindow = Number.isFinite(publishedMs) ? publishedMs >= sinceMs : true; // modified already passed
      if (!withinWindow) continue;
      const depName = vulnToDep.get(d.id)!;
      const cve = (d.aliases ?? []).find((a) => /^CVE-/i.test(a)) ?? null;
      const summary = (d.summary ?? d.details ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
      out.push({
        source: `security-watch:${osvEcosystem(depEco.get(depName) ?? "npm")}`,
        sourceItemId: d.id,
        title: `${depName}: ${sev} advisory${cve ? ` (${cve})` : ""}${summary ? ` — ${summary}` : ""}`,
        url: advisoryUrl(d),
        githubUrl: null,
        author: "security-watch",
        score: SEVERITY_RANK[sev] ?? 0,
        postedAt: Number.isFinite(publishedMs) ? new Date(publishedMs) : null,
        raw: {
          kind: "security-watch",
          depName,
          vulnId: d.id,
          cve,
          severity: sev,
          summary,
          notes: `${sev} security advisory affecting \`${depName}\`, a dependency this project uses${cve ? ` (${cve})` : ""}. ${summary}`,
          url: advisoryUrl(d),
        },
        primaryLanguage: null,
        topics: ["security-watch", depName.toLowerCase(), sev.toLowerCase(), ...(cve ? [cve.toLowerCase()] : [])],
      });
    }

    // Most severe first, then most recent. Cap.
    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || ((b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0)));
    const capped = out.slice(0, MAX_ADVISORIES);
    console.log(`[security-watch] user=${userId} ${depEco.size} deps → ${vulnToDep.size} recent advisories → ${capped.length} surfaced (min ${MIN_SEVERITY})`);
    return capped;
  },
};

// ── osv.dev client ──────────────────────────────────────────────────────────

type OsvVulnRef = { id: string; modified?: string };
type OsvVuln = {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  severity?: Array<{ type?: string; score?: string }>;
  references?: Array<{ type?: string; url?: string }>;
  database_specific?: { severity?: string };
};

// Batch query: returns vuln-ID lists parallel to the input packages. One POST
// for all deps. https://google.github.io/osv.dev/post-v1-querybatch/
async function osvQueryBatch(pkgs: Array<{ name: string; ecosystem: string }>): Promise<OsvVulnRef[][]> {
  const out: OsvVulnRef[][] = pkgs.map(() => []);
  const CHUNK = 100;
  for (let start = 0; start < pkgs.length; start += CHUNK) {
    const slice = pkgs.slice(start, start + CHUNK);
    try {
      const res = await fetch("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "replen/security-watch" },
        body: JSON.stringify({ queries: slice.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem } })) }),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { results?: Array<{ vulns?: OsvVulnRef[] }> };
      const results = json.results ?? [];
      for (let i = 0; i < slice.length; i++) out[start + i] = results[i]?.vulns ?? [];
    } catch {
      // leave this chunk empty; non-fatal
    }
  }
  return out;
}

async function osvVuln(id: string): Promise<OsvVuln | null> {
  const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
    headers: { "user-agent": "replen/security-watch", accept: "application/json" },
  });
  if (!res.ok) return null;
  return (await res.json()) as OsvVuln;
}

function severityOf(v: OsvVuln): string {
  // GHSA-backed records (the bulk of npm/PyPI) carry a clean label here.
  const ds = v.database_specific?.severity?.toUpperCase();
  if (ds && SEVERITY_RANK[ds]) return ds === "MEDIUM" ? "MODERATE" : ds;
  // Otherwise map a CVSS numeric base score if osv provided one as a bare
  // number (some sources do; the CVSS vector string itself we don't compute).
  for (const s of v.severity ?? []) {
    const n = parseFloat(s.score ?? "");
    if (Number.isFinite(n)) {
      if (n >= 9) return "CRITICAL";
      if (n >= 7) return "HIGH";
      if (n >= 4) return "MODERATE";
      return "LOW";
    }
  }
  return "UNKNOWN";
}

function advisoryUrl(v: OsvVuln): string {
  const adv = v.references?.find((r) => (r.type ?? "").toUpperCase() === "ADVISORY" && r.url);
  if (adv?.url) return adv.url;
  const ghsa = v.references?.find((r) => /github\.com\/advisories\//i.test(r.url ?? ""))?.url;
  if (ghsa) return ghsa;
  return `https://osv.dev/vulnerability/${v.id}`;
}

// osv.dev ecosystem names differ from our DepEcosystem labels.
function osvEcosystem(eco: DepEcosystem): string {
  switch (eco) {
    case "python": return "PyPI";
    case "cargo": return "crates.io";
    case "go": return "Go";
    default: return "npm";
  }
}

function inferEcosystem(techSummary: string | null): DepEcosystem {
  const s = (techSummary ?? "").toLowerCase();
  if (s.startsWith("python")) return "python";
  if (s.startsWith("rust") || s.includes("cargo")) return "cargo";
  if (s.startsWith("go ")) return "go";
  return "npm";
}

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
