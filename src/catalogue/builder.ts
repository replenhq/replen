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
import { eq } from "drizzle-orm";
import { embed, embedBatch, candidateEmbeddingText, serialiseEmbedding, facetEmbeddingText } from "../lib/embeddings";
import { inferRepoShape } from "../fetchers/repo-shape";
import { looksLikeHype } from "./derive-capabilities";
import { classifyRepos, KEEP_KINDS, type RepoKind } from "./classify";
import { type Modality } from "../projects/modality";
import { readRunOrEnv } from "../analyzer/run-context";

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
      const keep = hits.map((h, i) => ({ h, kind: cls[i].kind, modality: cls[i].modality })).filter((x) => x.kind === "unknown" || KEEP_KINDS.has(x.kind));
      if (keep.length > 0) {
        const vecs = await embedBatch(keep.map(({ h }) =>
          candidateEmbeddingText({ title: h.fullName, description: h.description, topics: h.topics, repoShape: h.shape, primaryLanguage: h.language }),
        ));
        for (let i = 0; i < keep.length; i++) {
          await upsertRepo(keep[i].h, label, vecs[i]?.vector ?? null, keep[i].kind, keep[i].modality);
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

async function upsertRepo(h: RepoHit, label: string, vector: number[] | null, kind: RepoKind, modality: Modality[]): Promise<void> {
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
      // Re-embed only when we have a fresh vector; keep the old one otherwise.
      embedding: vector ? serialiseEmbedding(vector) : existing.embedding,
      capabilities: JSON.stringify(caps.slice(0, 20)), lastSeen: now, updatedAt: now,
    }).where(eq(schema.catalogueRepos.id, existing.id));
  } else {
    await db.insert(schema.catalogueRepos).values({
      fullName: h.fullName, owner: h.owner, name: h.name, description: h.description, url: h.url,
      topics: JSON.stringify(h.topics), stars: h.stars, primaryLanguage: h.language, repoShape: h.shape,
      license: null, pushedAt: h.pushedAt, createdAt: h.createdAt, kind, modality: modalityJson,
      embedding: vector ? serialiseEmbedding(vector) : null,
      capabilities: JSON.stringify([label]), firstSeen: now, lastSeen: now, updatedAt: now,
    });
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
  const res = await fetch(url, { headers });
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
