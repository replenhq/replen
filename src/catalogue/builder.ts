// Phase 5 — catalogue builder. Populates the shared, capability-indexed library
// catalogue by searching GitHub for each capability the active projects need,
// keeping the high-quality libraries, embedding them, and upserting them into
// catalogue_repos (deduped by full_name, capabilities merged).
//
// Cross-user by construction: it's fed the union of capability labels and the
// per-capability refresh is tracked in catalogue_capabilities, so a capability
// one user's project surfaced is cached for the next user's project that shares
// it. Budget-bounded per run (a handful of new GitHub searches) so it warms
// gradually rather than hammering the API.

import { db, schema } from "../db/client";
import { eq, and, isNotNull } from "drizzle-orm";
import { isSeedCapability } from "./seed-capabilities";
import { embed, embedBatch, candidateEmbeddingText, cleanReadmeHead, serialiseEmbedding, facetEmbeddingText } from "../lib/embeddings";
import { inferRepoShape } from "../fetchers/repo-shape";
import { looksLikeHype } from "./derive-capabilities";
import { classifyRepos, KEEP_KINDS, type RepoKind } from "./classify";
import { type Modality } from "../projects/modality";
import { readRunOrEnv } from "../analyzer/run-context";
import { testUserIds } from "../lib/test-cohort";

const MIN_STARS = Math.max(0, parseInt(process.env.REPLEN_CATALOGUE_MIN_STARS ?? "80", 10) || 80);
const PER_CAPABILITY = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_PER_CAPABILITY ?? "8", 10) || 8);
// Allow 0 (force re-search every label) — a plain `|| 14` would coerce 0→14.
const REFRESH_DAYS = (() => {
  const v = parseInt(process.env.REPLEN_CATALOGUE_REFRESH_DAYS ?? "14", 10);
  return Number.isFinite(v) && v >= 0 ? v : 14;
})();
const MAX_SEARCHES_PER_RUN = Math.max(0, parseInt(process.env.REPLEN_CATALOGUE_MAX_SEARCHES ?? "8", 10) || 8);

// Labels that make poor GitHub queries (too generic / would match everything).
const GENERIC = new Set([
  "data", "api", "apis", "web", "app", "ui", "backend", "frontend", "database",
  "cli", "tooling", "testing", "automation", "integration", "platform",
  "python", "javascript", "typescript", "java", "rust", "go", "node",
]);

function usableLabel(label: string): boolean {
  const t = label.trim();
  if (t.length < 3 || t.length > 40) return false;
  if (t.split(/\s+/).length > 4) return false; // GitHub search won't match long phrases
  if (GENERIC.has(t.toLowerCase())) return false;
  return true;
}

type RepoHit = {
  fullName: string; owner: string; name: string; description: string | null;
  url: string; topics: string[]; stars: number | null; language: string | null;
  shape: string; pushedAt: Date | null; createdAt: Date | null;
};

/**
 * Refresh the catalogue for a set of capability labels. Picks the stalest
 * labels (not refreshed within REFRESH_DAYS), bounded by MAX_SEARCHES_PER_RUN,
 * searches GitHub for each, and upserts the quality libraries. Returns counts.
 */
export async function refreshCatalogue(labels: string[]): Promise<{ searched: number; upserted: number }> {
  const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of labels) {
    if (!usableLabel(raw)) continue;
    const key = raw.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(key);
  }
  if (candidates.length === 0) return { searched: 0, upserted: 0 };

  // Pick the stalest labels to refresh this run.
  const staleThreshold = Date.now() - REFRESH_DAYS * 24 * 3600 * 1000;
  const toRefresh: string[] = [];
  for (const label of candidates) {
    const row = await db.select().from(schema.catalogueCapabilities).where(eq(schema.catalogueCapabilities.label, label)).get();
    if (row && row.lastRefreshedAt.getTime() > staleThreshold) continue; // fresh — skip
    toRefresh.push(label);
    if (toRefresh.length >= MAX_SEARCHES_PER_RUN) break;
  }
  if (toRefresh.length === 0) return { searched: 0, upserted: 0 };

  // Stay under GitHub's search secondary rate limit (~30/min) on big backfills.
  const SEARCH_DELAY_MS = Math.max(0, parseInt(process.env.REPLEN_CATALOGUE_SEARCH_DELAY_MS ?? "1500", 10) || 1500);
  let upserted = 0;
  for (let i = 0; i < toRefresh.length; i++) {
    const label = toRefresh[i];
    if (i > 0 && SEARCH_DELAY_MS > 0) await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS));
    let hits: RepoHit[] = [];
    try {
      hits = await searchGithub(label, ghToken);
    } catch (e) {
      console.warn(`[catalogue] search "${label}" failed:`, (e as Error).message);
    }
    if (hits.length > 0) {
      // Library-vs-hype + modality classification (one pass).
      const cls = await classifyRepos(hits.map((h) => ({ fullName: h.fullName, description: h.description, topics: h.topics, stars: h.stars })));
      const keep = hits.map((h, i) => ({ h, kind: cls[i].kind, modality: cls[i].modality, summary: cls[i].summary })).filter((x) => x.kind === "unknown" || KEEP_KINDS.has(x.kind));
      if (keep.length > 0) {
        // README head per kept repo: reuse a stored one, else fetch (one API
        // call per NEW repo). The README is the difference between matching
        // ~50 words of metadata and matching what the project actually does.
        const readmeHeads: Array<string | null> = [];
        for (const { h } of keep) {
          const existing = await db.select({ readmeHead: schema.catalogueRepos.readmeHead })
            .from(schema.catalogueRepos).where(eq(schema.catalogueRepos.fullName, h.fullName)).get();
          readmeHeads.push(existing?.readmeHead ?? await fetchReadmeHead(h.fullName, ghToken));
        }
        const vecs = await embedBatch(keep.map(({ h, summary }, i) =>
          candidateEmbeddingText({ title: h.fullName, description: h.description, topics: h.topics, repoShape: h.shape, primaryLanguage: h.language, readmeHead: readmeHeads[i], capabilitySummary: summary }),
        ));
        for (let i = 0; i < keep.length; i++) {
          await upsertRepo(keep[i].h, label, vecs[i]?.vector ?? null, keep[i].kind, keep[i].modality, readmeHeads[i]);
          upserted++;
        }
      }
    }
    const now = new Date();
    // Embed the capability label itself (Phase 7 adjacency). Keep an existing
    // vector if this embed fails.
    const labelVec = await embed(facetEmbeddingText(label));
    const existing = await db.select().from(schema.catalogueCapabilities).where(eq(schema.catalogueCapabilities.label, label)).get();
    if (existing) {
      await db.update(schema.catalogueCapabilities).set({
        lastRefreshedAt: now, repoCount: hits.length,
        embedding: labelVec ? serialiseEmbedding(labelVec.vector) : existing.embedding,
      }).where(eq(schema.catalogueCapabilities.label, label));
    } else {
      await db.insert(schema.catalogueCapabilities).values({
        label, lastRefreshedAt: now, repoCount: hits.length,
        embedding: labelVec ? serialiseEmbedding(labelVec.vector) : null,
      });
    }
  }
  console.log(`[catalogue] refreshed ${toRefresh.length} capabilit${toRefresh.length === 1 ? "y" : "ies"} → ${upserted} repos upserted`);
  return { searched: toRefresh.length, upserted };
}

// Un-share reaper (k-anonymity is checked at share time; this closes the loop).
// A non-seed capability label enters catalogue_capabilities once ≥K distinct
// users have it, and is then refreshed/surfaced (adjacency) indefinitely. If the
// users who made it k-anonymous later delete their projects or accounts, the
// count silently falls below K but the label lingers forever. This recomputes
// distinct-user counts per label across active projects (test cohort excluded,
// matching the share-time gate) and retires non-seed labels that dropped below K.
// Runs in the nightly cron. Seed vocabulary is always kept.
export async function reapUnsharedCapabilities(
  K = Math.max(2, parseInt(process.env.REPLEN_CATALOGUE_MIN_USERS ?? "2", 10) || 2),
): Promise<number> {
  const testUids = await testUserIds();
  const rows = await db
    .select({ uid: schema.projectProfiles.userId, summaryJson: schema.projectProfiles.summaryJson })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.active, true), eq(schema.projectProfiles.included, true)));
  const usersByLabel = new Map<string, Set<number>>();
  for (const p of rows) {
    if (!p.summaryJson || p.uid == null || testUids.has(p.uid)) continue;
    let caps: string[] = [];
    try { caps = (JSON.parse(p.summaryJson) as { capabilityTags?: string[] }).capabilityTags ?? []; } catch { continue; }
    for (const c of caps) {
      if (typeof c !== "string") continue;
      const k = c.toLowerCase();
      let s = usersByLabel.get(k);
      if (!s) { s = new Set(); usersByLabel.set(k, s); }
      s.add(p.uid);
    }
  }
  const cats = await db.select({ label: schema.catalogueCapabilities.label }).from(schema.catalogueCapabilities);
  let reaped = 0;
  for (const { label } of cats) {
    if (isSeedCapability(label)) continue; // seed vocabulary is baseline, never reaped
    if ((usersByLabel.get(label.toLowerCase())?.size ?? 0) < K) {
      await db.delete(schema.catalogueCapabilities).where(eq(schema.catalogueCapabilities.label, label));
      reaped++;
    }
  }
  if (reaped) console.log(`[catalogue] reaped ${reaped} shared capabilit${reaped === 1 ? "y" : "ies"} that fell below k=${K}`);
  return reaped;
}

async function upsertRepo(h: RepoHit, label: string, vector: number[] | null, kind: RepoKind, modality: Modality[], readmeHead: string | null): Promise<void> {
  const now = new Date();
  const modalityJson = modality.length ? JSON.stringify(modality) : null;
  const existing = await db.select().from(schema.catalogueRepos).where(eq(schema.catalogueRepos.fullName, h.fullName)).get();
  if (existing) {
    // Merge the sourcing capability into the repo's capability list.
    let caps: string[] = [];
    try { caps = existing.capabilities ? JSON.parse(existing.capabilities) : []; } catch { caps = []; }
    if (!caps.map((c) => c.toLowerCase()).includes(label)) caps.push(label);
    await db.update(schema.catalogueRepos).set({
      description: h.description, url: h.url, topics: JSON.stringify(h.topics), stars: h.stars,
      primaryLanguage: h.language, repoShape: h.shape, pushedAt: h.pushedAt, createdAt: h.createdAt,
      kind: kind === "unknown" ? existing.kind : kind,
      // Keep a known modality if the new pass came back empty (unknown).
      modality: modalityJson ?? existing.modality,
      readmeHead: readmeHead ?? existing.readmeHead,
      // Re-embed only when we have a fresh vector; keep the old one otherwise.
      embedding: vector ? serialiseEmbedding(vector) : existing.embedding,
      capabilities: JSON.stringify(caps.slice(0, 20)), lastSeen: now, updatedAt: now,
    }).where(eq(schema.catalogueRepos.id, existing.id));
  } else {
    await db.insert(schema.catalogueRepos).values({
      fullName: h.fullName, owner: h.owner, name: h.name, description: h.description, url: h.url,
      topics: JSON.stringify(h.topics), stars: h.stars, primaryLanguage: h.language, repoShape: h.shape,
      license: null, pushedAt: h.pushedAt, createdAt: h.createdAt, kind, modality: modalityJson,
      readmeHead,
      embedding: vector ? serialiseEmbedding(vector) : null,
      capabilities: JSON.stringify([label]), firstSeen: now, lastSeen: now, updatedAt: now,
    });
  }
}

// #3 — flywheel promotion. A fetcher candidate that independently surfaced for
// ≥K DISTINCT users is generically useful (not one user's niche), so it earns a
// place in the warm cross-user catalogue, where it gets the full enrichment
// (kind/modality/capability descriptor + README embed) ONCE, shared by everyone.
// k-anonymity holds exactly as for capability sharing (run-once.ts §5): only the
// repo's OWN public GitHub metadata enters — never a user_id, a repo of theirs,
// or a capability term of theirs. The label seeded into the catalogue comes from
// the repo's own topics, not any user vocabulary. Runs once per all-users run.
export async function promoteCandidatesToCatalogue(): Promise<{ promoted: number }> {
  const K = Math.max(2, parseInt(process.env.REPLEN_CATALOGUE_MIN_USERS ?? "2", 10) || 2);
  const CAP = Math.max(0, parseInt(process.env.REPLEN_CATALOGUE_PROMOTE_CAP ?? "40", 10) || 40);
  const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");

  // Distinct-user count per GitHub repo across the whole candidate pool.
  // Test-cohort users are EXCLUDED from the count (same cross-user invariant as
  // refreshCatalogueStep): a synthetic cohort we control must never be able to
  // push a repo over the K threshold into the shared catalogue.
  const testUids = await testUserIds();
  const rows = await db
    .select({ githubUrl: schema.candidates.githubUrl, userId: schema.candidates.userId })
    .from(schema.candidates)
    .where(isNotNull(schema.candidates.githubUrl));
  const byRepo = new Map<string, Set<number>>();
  for (const r of rows) {
    const m = r.githubUrl?.toLowerCase().match(/github\.com\/([^/]+\/[^/#?]+)/);
    if (!m || r.userId == null || testUids.has(r.userId)) continue;
    const fn = m[1].replace(/\.git$/, "");
    let s = byRepo.get(fn);
    if (!s) { s = new Set(); byRepo.set(fn, s); }
    s.add(r.userId);
  }
  const qualified = [...byRepo.entries()].filter(([, users]) => users.size >= K).map(([fn]) => fn);
  if (qualified.length === 0) return { promoted: 0 };

  const already = new Set(
    (await db.select({ fullName: schema.catalogueRepos.fullName }).from(schema.catalogueRepos))
      .map((r) => r.fullName.toLowerCase()),
  );
  const todo = qualified.filter((fn) => !already.has(fn)).slice(0, CAP);
  let promoted = 0;
  for (const fn of todo) {
    const hit = await fetchRepoMeta(fn, ghToken);
    if (!hit) continue;
    const [cls] = await classifyRepos([{ fullName: hit.fullName, description: hit.description, topics: hit.topics, stars: hit.stars }]);
    // Drop viral hype / curated-content repos — the catalogue is adoptable libs.
    if (!cls || !(cls.kind === "unknown" || KEEP_KINDS.has(cls.kind))) continue;
    const readmeHead = await fetchReadmeHead(fn, ghToken);
    const vec = await embed(candidateEmbeddingText({
      title: hit.fullName, description: hit.description, topics: hit.topics,
      repoShape: hit.shape, primaryLanguage: hit.language, readmeHead, capabilitySummary: cls.summary,
    }));
    // Sourcing label from the repo's OWN vocabulary (never a user's capability term).
    const label = (hit.topics.find((t) => t && t.length > 2) ?? hit.language ?? "discovered").toLowerCase();
    await upsertRepo(hit, label, vec?.vector ?? null, cls.kind, cls.modality, readmeHead);
    promoted++;
  }
  if (promoted > 0) console.log(`[catalogue] promoted ${promoted} k-anon candidate(s) (≥${K} users) into the catalogue`);
  return { promoted };
}

// Authoritative repo metadata (stars/dates/description/topics) for a promoted
// candidate — the candidate row doesn't carry it. One GET /repos per promotion.
async function fetchRepoMeta(fullName: string, token: string | undefined): Promise<RepoHit | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json", "user-agent": "replen/catalogue", "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const [owner, name] = fullName.split("/");
    return {
      fullName, owner: owner ?? "", name: name ?? "",
      description: typeof j.description === "string" ? j.description : null,
      url: typeof j.html_url === "string" ? j.html_url : `https://github.com/${fullName}`,
      topics: Array.isArray(j.topics) ? (j.topics as unknown[]).filter((t): t is string => typeof t === "string") : [],
      stars: typeof j.stargazers_count === "number" ? j.stargazers_count : null,
      language: typeof j.language === "string" ? j.language : null,
      shape: "unknown",
      pushedAt: typeof j.pushed_at === "string" ? new Date(j.pushed_at) : null,
      createdAt: typeof j.created_at === "string" ? new Date(j.created_at) : null,
    };
  } catch {
    return null;
  }
}

// Fetch a repo's README head (cleaned prose, ~1.5k chars). Best-effort: a 404
// (no README) or a rate-limit just yields null — the embed falls back to
// title/description/topics, same as before.
export async function fetchReadmeHead(fullName: string, token: string | undefined): Promise<string | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github.raw+json",
    "user-agent": "replen/catalogue",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return cleanReadmeHead(await res.text());
  } catch {
    return null;
  }
}

// GitHub repo search for a capability, sorted by stars — we want the canonical
// high-quality libraries for the capability, not the freshest churn.
async function searchGithub(label: string, token: string | undefined): Promise<RepoHit[]> {
  const q = `${label} stars:>=${MIN_STARS} archived:false`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_CAPABILITY}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "replen/catalogue",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  // Bounded like fetchReadmeHead — this runs INSIDE the awaited catalogue phase,
  // outside the per-fetcher timeout umbrella, so a hung GitHub search would
  // otherwise stall the whole pipeline.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
  const out: RepoHit[] = [];
  for (const item of json.items ?? []) {
    const fullName = String(item.full_name ?? "");
    const [owner, name] = fullName.split("/");
    if (!owner || !name) continue;
    const description = item.description ? String(item.description).trim() : null;
    const topics = Array.isArray(item.topics) ? (item.topics as unknown[]).filter((t): t is string => typeof t === "string") : [];
    const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
    const language = typeof item.language === "string" ? item.language : null;
    const shape = inferRepoShape({ name, description, topics });
    // Firehose guard: aggregators (awesome-lists) and templates/starters are
    // never libraries you'd adopt for a capability. Drop them at source. (We
    // keep 'tutorial' despite some false positives — inferRepoShape mislabels
    // deep-learning libraries as tutorials via the "learning" keyword, so
    // filtering it would drop genuine libs like opencv.)
    if (shape === "aggregator" || shape === "template") continue;
    if (looksLikeHype(name, description)) continue; // skills/awesome/roadmap hype, not a library
    out.push({
      fullName, owner, name, description,
      url: `https://github.com/${fullName}`,
      topics, stars, language,
      shape,
      pushedAt: item.pushed_at ? new Date(String(item.pushed_at)) : null,
      createdAt: item.created_at ? new Date(String(item.created_at)) : null,
    });
  }
  return out;
}
