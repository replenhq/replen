// Trending / historical catalogue ingestion. Complements the capability-search
// builder: instead of "the canonical library for capability X", this walks
// GitHub's best repos created across MONTHLY windows going back N months, so
// the catalogue also captures repos that rose to prominence over the period —
// not just all-time leaders. Monthly buckets give a balanced spread (without
// them, sort-by-stars returns the same megaprojects every window).
//
// Each ingested repo is auto-tagged with its nearest capabilities (cosine of
// its embedding against the catalogue's capability vectors), so trending repos
// are capability-indexed like the rest. Untagged repos are still stored and
// still match via embedding cosine in the reader.

import { db, schema } from "../db/client";
import { eq, isNotNull } from "drizzle-orm";
import {
  embedBatch, candidateEmbeddingText, serialiseEmbedding,
  cosineSimilarity, parseStoredEmbedding,
} from "../lib/embeddings";
import { inferRepoShape } from "../fetchers/repo-shape";
import { looksLikeHype } from "./derive-capabilities";
import { classifyRepos, KEEP_KINDS, type RepoKind } from "./classify";
import { readRunOrEnv } from "../analyzer/run-context";

// Repo→capability-label cosine runs lower than repo→repo, so 0.45 is the right
// bar for "this trending repo is about capability X".
const TAG_THRESHOLD = Math.min(1, Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_TAG_COSINE ?? "0.45")));
const MAX_TAGS = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_TAG_MAX ?? "4", 10) || 4);

type Hit = {
  fullName: string; owner: string; name: string; description: string | null;
  url: string; topics: string[]; stars: number | null; language: string | null;
  shape: string; pushedAt: Date | null; createdAt: Date | null;
};

export async function ingestHistorical(opts: {
  monthsBack: number;
  languages: string[];        // include "" for an all-languages pass
  starsMin: number;
  perWindow: number;
  spacingMs: number;
  requireTag?: boolean;       // drop trending repos that match no capability (noise gate)
}): Promise<{ searched: number; ingested: number; tagged: number; dropped: number }> {
  const { monthsBack, languages, starsMin, perWindow, spacingMs } = opts;
  const requireTag = opts.requireTag ?? true;
  const ghToken = readRunOrEnv("githubToken", "GITHUB_TOKEN");

  // Capability vectors for auto-tagging.
  const capRows = await db.select().from(schema.catalogueCapabilities).where(isNotNull(schema.catalogueCapabilities.embedding));
  const capVecs = capRows
    .map((c) => ({ label: c.label, vec: parseStoredEmbedding(c.embedding) }))
    .filter((c): c is { label: string; vec: number[] } => c.vec !== null);

  const now = new Date();
  const seen = new Set<string>();
  const hits: Hit[] = [];
  let searched = 0;

  for (const lang of languages) {
    for (let m = 0; m < monthsBack; m++) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m + 1, 0));
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const langQ = lang ? ` language:${lang}` : "";
      const q = `created:${fmt(start)}..${fmt(end)} stars:>=${starsMin} archived:false${langQ}`;
      if (searched > 0 && spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
      searched++;
      try {
        const found = await searchWindow(q, perWindow, ghToken);
        for (const h of found) {
          if (seen.has(h.fullName.toLowerCase())) continue;
          seen.add(h.fullName.toLowerCase());
          hits.push(h);
        }
      } catch (e) {
        console.warn(`[catalogue/historical] "${q}" failed: ${(e as Error).message}`);
      }
    }
  }
  if (hits.length === 0) return { searched, ingested: 0, tagged: 0, dropped: 0 };

  // Embed in batches (OpenAI accepts large arrays; chunk to be safe).
  const CHUNK = 100;
  let ingested = 0, tagged = 0, dropped = 0;
  for (let i = 0; i < hits.length; i += CHUNK) {
    const slice = hits.slice(i, i + CHUNK);
    const kinds = await classifyRepos(slice.map((h) => ({ fullName: h.fullName, description: h.description, topics: h.topics, stars: h.stars })));
    const vecs = await embedBatch(slice.map((h) =>
      candidateEmbeddingText({ title: h.fullName, description: h.description, topics: h.topics, repoShape: h.shape, primaryLanguage: h.language }),
    ));
    for (let j = 0; j < slice.length; j++) {
      const h = slice[j];
      // Library-vs-hype: drop viral experiments + curated content.
      if (kinds[j] !== "unknown" && !KEEP_KINDS.has(kinds[j])) { dropped++; continue; }
      const vec = vecs[j]?.vector ?? null;
      const caps = vec ? tagCapabilities(vec, capVecs) : [];
      // Noise gate: a trending repo that matches no known capability is most
      // likely hype, a personal project, or a non-library — skip it.
      if (requireTag && caps.length === 0) { dropped++; continue; }
      if (caps.length > 0) tagged++;
      await upsert(h, caps, vec, kinds[j]);
      ingested++;
    }
  }
  console.log(`[catalogue/historical] ${searched} windows → ${hits.length} repos → ${ingested} upserted (${tagged} tagged, ${dropped} dropped as off-capability)`);
  return { searched, ingested, tagged, dropped };
}

function tagCapabilities(repoVec: number[], capVecs: Array<{ label: string; vec: number[] }>): string[] {
  const scored: Array<{ label: string; cos: number }> = [];
  for (const c of capVecs) {
    const cos = cosineSimilarity(repoVec, c.vec);
    if (Number.isFinite(cos) && cos >= TAG_THRESHOLD) scored.push({ label: c.label, cos });
  }
  scored.sort((a, b) => b.cos - a.cos);
  return scored.slice(0, MAX_TAGS).map((s) => s.label);
}

async function upsert(h: Hit, caps: string[], vector: number[] | null, kind: RepoKind): Promise<void> {
  const now = new Date();
  const existing = await db.select().from(schema.catalogueRepos).where(eq(schema.catalogueRepos.fullName, h.fullName)).get();
  if (existing) {
    let merged: string[] = [];
    try { merged = existing.capabilities ? JSON.parse(existing.capabilities) : []; } catch { merged = []; }
    const lower = new Set(merged.map((c) => c.toLowerCase()));
    for (const c of caps) if (!lower.has(c.toLowerCase())) { merged.push(c); lower.add(c.toLowerCase()); }
    await db.update(schema.catalogueRepos).set({
      description: h.description, url: h.url, topics: JSON.stringify(h.topics), stars: h.stars,
      primaryLanguage: h.language, repoShape: h.shape, pushedAt: h.pushedAt, createdAt: h.createdAt,
      kind: kind === "unknown" ? existing.kind : kind,
      embedding: vector ? serialiseEmbedding(vector) : existing.embedding,
      capabilities: JSON.stringify(merged.slice(0, 20)), lastSeen: now, updatedAt: now,
    }).where(eq(schema.catalogueRepos.id, existing.id));
  } else {
    await db.insert(schema.catalogueRepos).values({
      fullName: h.fullName, owner: h.owner, name: h.name, description: h.description, url: h.url,
      topics: JSON.stringify(h.topics), stars: h.stars, primaryLanguage: h.language, repoShape: h.shape,
      license: null, pushedAt: h.pushedAt, createdAt: h.createdAt, kind, embedding: vector ? serialiseEmbedding(vector) : null,
      capabilities: JSON.stringify(caps), firstSeen: now, lastSeen: now, updatedAt: now,
    });
  }
}

async function searchWindow(q: string, perPage: number, token: string | undefined): Promise<Hit[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json", "user-agent": "replen/catalogue-historical", "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
  const out: Hit[] = [];
  for (const item of json.items ?? []) {
    const fullName = String(item.full_name ?? "");
    const [owner, name] = fullName.split("/");
    if (!owner || !name) continue;
    const description = item.description ? String(item.description).trim() : null;
    const topics = Array.isArray(item.topics) ? (item.topics as unknown[]).filter((t): t is string => typeof t === "string") : [];
    const shape = inferRepoShape({ name, description, topics });
    if (shape === "aggregator" || shape === "template") continue; // firehose guard
    if (looksLikeHype(name, description)) continue; // skills/awesome/roadmap hype, not a library
    out.push({
      fullName, owner, name, description, url: `https://github.com/${fullName}`,
      topics, stars: typeof item.stargazers_count === "number" ? item.stargazers_count : null,
      language: typeof item.language === "string" ? item.language : null, shape,
      pushedAt: item.pushed_at ? new Date(String(item.pushed_at)) : null,
      createdAt: item.created_at ? new Date(String(item.created_at)) : null,
    });
  }
  return out;
}
