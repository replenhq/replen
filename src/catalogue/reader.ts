// Phase 5 — catalogue reader. Matches the shared capability catalogue against a
// scoped project, using the SAME faceted scoring as the per-user pool: best of
// (project centroid, project facets) cosine, with the same relevance floor and
// competitor suppression. So the catalogue surfaces a library that fills one of
// the project's capabilities even when the project's own targeted search hasn't
// fetched it yet — without becoming a trending firehose.

import { db, schema } from "../db/client";
import { desc, isNotNull } from "drizzle-orm";
import { cosineSimilarity, parseStoredEmbedding, type FacetEmbedding } from "../lib/embeddings";
import { KEEP_KINDS, RISING_KINDS, type RepoKind } from "./classify";
import { modalitiesDisjoint, coerceModalities, type Modality, type Provenance } from "../projects/modality";

// Provenance confidence: a match on a GROUNDED capability (the agent read the
// code) is more trustworthy than one on an AMBIGUOUS doc-section facet (which
// may be noise). Nudge the score by how well we know the capability is real.
const PROVENANCE_ADJ: Record<Provenance, number> = { grounded: 0.03, extracted: 0.015, inferred: 0, ambiguous: -0.05 };
const provenanceAdj = (p: Provenance | undefined): number => (p ? PROVENANCE_ADJ[p] : 0);

/** Parse a catalogue repo's stored modality JSON into a clean Modality[]. */
function repoModality(raw: string | null): Modality[] {
  if (!raw) return [];
  try { return coerceModalities(JSON.parse(raw)); } catch { return []; }
}

export type CatalogueMatch = {
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  url: string | null;
  stars: number | null;
  language: string | null;
  license: string | null;
  topics: string[];
  repoShape: string | null;
  cosine: number;
  matchedFacet: string | null;
  matchedProvenance: Provenance | null; // how grounded the matched capability is
  matchedRepo: string | null; // sibling repo this is for, when cross-repo (multi-repo products)
  ageDays: number | null;   // repo age; null when unknown
  rising: boolean;          // recent + relevant → "rising in your space"
};

// Language/runtime compatibility. A library is only useful if you can actually
// use it. Platform-locked languages (Java/Android, Swift/iOS, C#/.NET, Dart) are
// hard-incompatible — you can't import an Android job-queue into a Node bot — so
// a repo in one of those, for a project that doesn't use it, is excluded.
// Other cross-language (Python/Rust/Go/C) is a SOFT penalty: you might use it via
// a sidecar or port the idea, but it shouldn't outrank a same-language fit.
const PLATFORM_LOCKED = new Set(["java", "kotlin", "swift", "objective-c", "objective-c++", "dart", "c#", "scala", "groovy"]);
const JS_FAMILY = new Set(["javascript", "typescript", "coffeescript"]);
const CROSS_LANG_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_CROSSLANG_PENALTY ?? "0.06"));

// Value penalty — "covered": you already have a library for this (commodity)
// capability (it's a dep) → suggesting another is "more of what you have", low
// value. NOTE: deliberately NOT a star-count penalty. In the vibe-coding era a
// repo amasses 40k+ stars in weeks, and a genuinely great niche tool (scrapling)
// is high-star yet agents never reach for it — that's exactly what Replen should
// surface. Stars are a terrible "obvious" proxy; "obvious" = the agent's default,
// which the commodity filter + known-deps exclusion already capture categorically.
const COVERED_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_COVERED_PENALTY ?? "0.10"));
const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Commodity-layer suppression — the core "don't suggest basic stuff" lever.
// A novel library in the project's DOMAIN (a new computer-vision method, a
// drone-training kit) is high-leverage and welcome even if the project already
// does CV. But a generic frontend/styling/charting/UI-component/util library
// (Tailwind, ECharts, a headless-UI kit) is "basic, everyone knows it, the
// in-session agent already picked one" — not worth flagging. We classify the
// CANDIDATE by its own nature (topics/name/description), not the project, so a
// CSS library is commodity no matter what facet it matched. NOTE: deliberately
// NOT "graph" (graph memory/DB is domain) — only "graphing/charting/dataviz".
const COMMODITY_RE = /\b(css|tailwind|scss|sass|less|postcss|css-?in-?js|styled-?components?|stylesheet|styling|theming|themes?|design-?systems?|ui-?kit|ui-?components?|ui-?library|component-?librar(?:y|ies)|headless-?ui|chart|charts|charting|dataviz|data-?visualization|d3|echarts|plotly|graphing|icons?|iconsets?|fonts?|typography|animations?|transitions?|carousel|sliders?|modals?|dialog|tooltips?|popovers?|dropdowns?|datepickers?|date-?pickers?|forms?|form-?validation|state-?management|redux|mobx|zustand|recoil|routing|routers?|bundlers?|webpack|vite|rollup|esbuild|parcel|eslint|prettier|formatters?|linters?|boilerplate|starter-?kits?|scaffold(?:ing)?|markdown-?render(?:er)?|syntax-?highlight(?:ing)?|wysiwyg|rich-?text-?editors?|layout|grid-?system|flexbox|dark-?mode|toasts?|notification-?ui|spinners?|loaders?|skeleton-?ui|datagrids?|data-?grids?|pagination|breadcrumbs?|navbar|sidebar-?ui|avatars?)\b/i;
const COMMODITY_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_COMMODITY_PENALTY ?? "0.18"));
function isCommodityText(s: string | null | undefined): boolean {
  return !!s && COMMODITY_RE.test(s);
}
function commodityPenalty(name: string, description: string | null, topics: string[]): number {
  if (isCommodityText(name) || isCommodityText(description) || topics.some(isCommodityText)) return COMMODITY_PENALTY;
  return 0;
}

// Infrastructure-plumbing suppression — the "you already have Postgres, here are
// four ways to migrate it" lever. A matched facet is one of the project's OWN
// capabilities, so a match on an infra/plumbing facet (database, migrations,
// auth, caching, a web framework) is "more plumbing for infra you already have"
// — low leverage. Penalised so genuine DOMAIN matches lead; weak infra matches
// fall below the floor → silence. Deliberately applies ONLY in the catalogue
// path (facets you HAVE), never in adjacency (a NOVEL infra capability you DON'T
// have — graph memory, a vector store — is exactly the leap we want to surface).
const INFRA_FACET = /\b(postgres(?:ql)?|mysql|mariadb|sqlite|mongo(?:db)?|redis|dynamodb|cassandra|cockroach(?:db)?|databases?|migrations?|orm|prisma|drizzle|sequelize|typeorm|knex|mongoose|authentication|auth|authorization|oauth2?|openid|jwt|sessions?|logging|logger|observability|telemetry|caching?|message\s?queues?|queues?|kafka|rabbitmq|celery|bullmq|pub.?sub|docker|kubernetes|k8s|helm|terraform|ansible|pulumi|ci.?cd|rest\s?apis?|graphql|websockets?|grpc|crons?|schedulers?|smtp|object\s?storage|rate.?limit(?:ing)?|dotenv|next\.?js|nuxt|remix|express|fastify|fastapi|nestjs|django|flask|rails|laravel|spring\s?boot|react|vue|svelte|angular)\b/i;
const INFRA_PENALTY = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_INFRA_PENALTY ?? "0.10"));
const isInfraFacet = (label: string | null) => !!label && INFRA_FACET.test(label);

// Per-capability cap — one matched facet can contribute at most this many
// candidates, so a single capability can't flood the slate with near-identical
// alternatives (four Postgres migration tools). Quality over a menu.
const MAX_PER_FACET = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_MAX_PER_FACET ?? "2", 10) || 2);

// Returns Infinity (exclude) for hard-incompatible, else a cosine penalty.
function languagePenalty(projectLangs: Set<string>, repoLang: string | null): number {
  if (!repoLang || projectLangs.size === 0) return 0;
  const rl = repoLang.toLowerCase();
  if (projectLangs.has(rl)) return 0;
  if (JS_FAMILY.has(rl) && [...projectLangs].some((l) => JS_FAMILY.has(l))) return 0;
  if (PLATFORM_LOCKED.has(rl)) return Infinity; // can't import it — exclude
  return CROSS_LANG_PENALTY; // sidecar/port-able, but down-rank vs same-language
}

// Recency/trending boost. A recently-CREATED repo that's relevant is the
// "rising gem" signal — the thing you'd catch on a creator's feed before it's
// canonical. It gets a bonus added to its ranking score (not its cosine — the
// relevance floor still applies), so a fresh newcomer ranks alongside/above the
// all-time star leader instead of being buried under it. Linear decay over the
// window. "rising" flags repos young enough to call out as discoveries.
const RECENCY_MONTHS = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_RECENCY_MONTHS ?? "12", 10) || 12);
const RECENCY_MAX_BOOST = Math.max(0, parseFloat(process.env.REPLEN_CATALOGUE_RECENCY_BOOST ?? "0.08"));
const RISING_MONTHS = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_RISING_MONTHS ?? "9", 10) || 9);

function recencyBoost(ageDays: number | null): number {
  if (ageDays == null || ageDays < 0) return 0;
  const windowDays = RECENCY_MONTHS * 30;
  if (ageDays >= windowDays) return 0;
  return RECENCY_MAX_BOOST * (1 - ageDays / windowDays);
}

// Upper bound on how many catalogue rows we cosine per request. The catalogue
// starts small; ordering by stars means the cap keeps the canonical libraries
// when it grows. Bump if the catalogue gets large and recall suffers.
const SCAN_CAP = Math.max(100, parseInt(process.env.REPLEN_CATALOGUE_SCAN_CAP ?? "4000", 10) || 4000);

export async function catalogueMatches(opts: {
  projectEmbedding: number[] | null;
  projectFacets: FacetEmbedding[];
  minCosine: number;
  competitorCentroid: number;
  facetLead: number;
  excludeFullNames: Set<string>; // lowercased owner/name already surfaced or excluded
  projectLanguages: Set<string>;  // lowercased; for runtime-compatibility gating
  knownDeps: Set<string>;         // lowercased dep tokens the project already uses — don't suggest back
  coveredFacets: Set<string>;     // normLabel'd capability facets the project already has a dep for
  limit: number;
}): Promise<CatalogueMatch[]> {
  const { projectEmbedding, projectFacets, minCosine, competitorCentroid, facetLead, excludeFullNames, projectLanguages, knownDeps, coveredFacets, limit } = opts;
  if (!projectEmbedding && projectFacets.length === 0) return [];

  const rows = await db
    .select()
    .from(schema.catalogueRepos)
    .where(isNotNull(schema.catalogueRepos.embedding))
    .orderBy(desc(schema.catalogueRepos.stars))
    .limit(SCAN_CAP);

  const out: CatalogueMatch[] = [];
  for (const r of rows) {
    if (excludeFullNames.has(r.fullName.toLowerCase())) continue;
    // Already a dependency of this project (or its product) — suggesting a
    // library you already use is noise. Match by repo name OR owner.
    if (knownDeps.size > 0 && (knownDeps.has(r.name.toLowerCase()) || knownDeps.has(r.owner.toLowerCase()))) continue;
    const emb = parseStoredEmbedding(r.embedding);
    if (!emb) continue;

    const centroidCos = projectEmbedding ? cosineSimilarity(projectEmbedding, emb) : NaN;
    const cVal = Number.isFinite(centroidCos) ? centroidCos : -Infinity;

    let bestFacet = -Infinity;
    let bestFacetLabel: string | null = null;
    let bestFacetRepo: string | undefined;
    let bestFacetModality: Modality[] | undefined;
    let bestFacetProvenance: Provenance | undefined;
    for (const f of projectFacets) {
      const s = cosineSimilarity(f.vec, emb);
      if (Number.isFinite(s) && s > bestFacet) { bestFacet = s; bestFacetLabel = f.label; bestFacetRepo = f.repo; bestFacetModality = f.modality; bestFacetProvenance = f.provenance; }
    }

    const cosine = Math.max(cVal, bestFacet);
    const langPen = languagePenalty(projectLanguages, r.primaryLanguage);
    if (langPen === Infinity) continue; // runtime-incompatible — can't use it

    const facetLed = bestFacetLabel !== null && Number.isFinite(bestFacet) && bestFacet >= cVal;
    const matchedFacet = facetLed ? bestFacetLabel : null;

    // Cross-modal gate: the capability you matched on operates on a DIFFERENT
    // data modality than this library (telemetry "anomaly detection" vs an IMAGE
    // anomaly lib). A word collision, not a fit — exclude, like a runtime you
    // can't use. Only when facet-led + both sides have a known modality (unknown
    // on either side keeps the gate open, so a warming catalogue never over-cuts).
    if (facetLed && modalitiesDisjoint(bestFacetModality, repoModality(r.modality))) continue;

    // Self-match: the candidate IS the framework this facet is named after —
    // "NestJS" → nestjs/nest, "FastAPI" → fastapi/fastapi, "Terraform" →
    // hashicorp/terraform. You're built on it; suggesting it (or its first-party
    // org) back is the most obvious non-discovery, and dep-exclusion misses it
    // when deps are scoped (@nestjs/core) or in an un-parsed ecosystem (Python,
    // Terraform). Catalogue-path only: in adjacency, matching a capability you
    // DON'T have is the whole point, so this guard lives here, not there.
    if (matchedFacet) {
      const nf = normLabel(matchedFacet);
      if (nf && (nf === normLabel(r.name) || nf === normLabel(r.owner))) continue;
    }

    let topics: string[] = [];
    try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { /* ignore */ }

    // Value penalties — push the agent's defaults down so the non-obvious surfaces:
    //   commodity: a generic frontend/styling/UI/charting library is "basic"
    //              regardless of relevance — the in-session agent already picked
    //              one. Suppress hard. (A novel DOMAIN library is NOT commodity.)
    //   covered: you already have a library for a COMMODITY capability → another
    //            one is pure noise. (Deliberately NOT applied to domain facets —
    //            a novel CV method is welcome even though you already do CV.)
    //   infra: a match on a plumbing capability you already have (Postgres,
    //          migrations, a web framework) is low leverage — domain wins.
    //   provenance: trust a match on a grounded capability over an ambiguous
    //               doc-section one (a small confidence nudge, not a gate).
    const commodityPen = commodityPenalty(r.name, r.description, topics);
    const coveredPen = matchedFacet && isCommodityText(matchedFacet) && coveredFacets.has(normLabel(matchedFacet)) ? COVERED_PENALTY : 0;
    const infraPen = isInfraFacet(matchedFacet) ? INFRA_PENALTY : 0;
    const matchedProvenance = facetLed ? (bestFacetProvenance ?? null) : null;
    const effective = cosine - langPen - commodityPen - coveredPen - infraPen + provenanceAdj(matchedProvenance ?? undefined);
    if (!Number.isFinite(effective) || effective < minCosine) continue;

    const facetLeads = Number.isFinite(bestFacet) && bestFacet >= cVal + facetLead;
    // Competitor suppression: an app that matches the whole project (high
    // centroid) without leading on a specific capability is a competitor.
    if (r.repoShape === "app" && Number.isFinite(centroidCos) && centroidCos >= competitorCentroid && !facetLeads) continue;

    // Library-vs-hype: skip viral experiments + curated content outright (a
    // classified row that isn't adoptable). Unclassified (null) is allowed.
    const kind = (r.kind ?? "unknown") as RepoKind;
    if (r.kind && !KEEP_KINDS.has(kind)) continue;

    const matchedRepo = facetLed ? (bestFacetRepo ?? null) : null;

    const ageDays = r.createdAt ? Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000) : null;
    const recencyEligible = RISING_KINDS.has(kind);
    out.push({
      fullName: r.fullName, owner: r.owner, name: r.name, description: r.description,
      url: r.url, stars: r.stars, language: r.primaryLanguage, license: r.license,
      topics, repoShape: r.repoShape, cosine, matchedFacet, matchedProvenance, matchedRepo,
      ageDays, rising: recencyEligible && ageDays != null && ageDays <= RISING_MONTHS * 30,
    });
  }

  // Rank by: relevance + recency − cross-language − commodity − covered − infra.
  // A fresh, non-obvious, DOMAIN gap-filler ranks above a commodity library, an
  // alternative to something you already have, or more plumbing for existing
  // infra. Stars are NOT a penalty — a great high-star niche tool the agent
  // ignores is exactly what we want to surface.
  const score = (m: CatalogueMatch) =>
    m.cosine
    + (m.rising ? recencyBoost(m.ageDays) : 0)
    - languagePenalty(projectLanguages, m.language)
    - commodityPenalty(m.name, m.description, m.topics)
    - (m.matchedFacet && isCommodityText(m.matchedFacet) && coveredFacets.has(normLabel(m.matchedFacet)) ? COVERED_PENALTY : 0)
    - (isInfraFacet(m.matchedFacet) ? INFRA_PENALTY : 0)
    + provenanceAdj(m.matchedProvenance ?? undefined);
  out.sort((a, b) => score(b) - score(a));

  // Per-capability cap: one matched facet contributes at most MAX_PER_FACET, so a
  // single capability can't flood the slate with near-identical alternatives.
  // Centroid-led matches (null facet) each get a unique key — never collapsed.
  const perFacet = new Map<string, number>();
  const capped: CatalogueMatch[] = [];
  for (const m of out) {
    const key = m.matchedFacet ? normLabel(m.matchedFacet) : `__centroid__${capped.length}`;
    const n = perFacet.get(key) ?? 0;
    if (n >= MAX_PER_FACET) continue;
    perFacet.set(key, n + 1);
    capped.push(m);
    if (capped.length >= limit) break;
  }
  return capped;
}

export type AdjacentMatch = CatalogueMatch & {
  adjacentTo: string;       // the project capability this is adjacent to
  adjacentCapability: string; // the catalogue capability the library provides
};

// Phase 7 — capability adjacency. Find catalogue capabilities whose vector is
// NEAR but DISTINCT from one of the project's capabilities (the project doesn't
// have it, but it's in the neighbourhood), and surface the best library for
// each as an exploratory suggestion. Gated to a band (too close = the project
// effectively already has it; too far = unrelated) and capped tight — this is
// the "you don't use this yet, but it could help" feature, not a firehose.
export async function adjacentMatches(opts: {
  projectFacets: FacetEmbedding[];
  ownedCapabilities: Set<string>; // lowercased labels the project already has (its own facets)
  projectLanguages: Set<string>;  // lowercased; for runtime-compatibility gating
  excludeFullNames: Set<string>;
  adjLo: number;
  adjHi: number;
  maxCapabilities: number;
  competitorCentroid: number;
  limit: number;
}): Promise<AdjacentMatch[]> {
  const { projectFacets, ownedCapabilities, projectLanguages, excludeFullNames, adjLo, adjHi, maxCapabilities, limit } = opts;
  if (projectFacets.length === 0) return [];

  const caps = await db
    .select()
    .from(schema.catalogueCapabilities)
    .where(isNotNull(schema.catalogueCapabilities.embedding));

  // Rank candidate adjacent capabilities by how close they sit to the project.
  const adj: Array<{ label: string; nearest: string; cos: number }> = [];
  for (const c of caps) {
    if (ownedCapabilities.has(c.label.toLowerCase())) continue; // already a project capability
    if (isCommodityText(c.label)) continue; // a "basic" commodity layer is never an exploratory leap
    const v = parseStoredEmbedding(c.embedding);
    if (!v) continue;
    let best = -Infinity;
    let nearest: string | null = null;
    for (const f of projectFacets) {
      const s = cosineSimilarity(v, f.vec);
      if (Number.isFinite(s) && s > best) { best = s; nearest = f.label; }
    }
    if (nearest !== null && best >= adjLo && best <= adjHi) adj.push({ label: c.label, nearest, cos: best });
  }
  adj.sort((a, b) => b.cos - a.cos);
  const top = adj.slice(0, maxCapabilities);
  if (top.length === 0) return [];

  // Pull the best library for each adjacent capability (one per capability).
  const repos = await db
    .select()
    .from(schema.catalogueRepos)
    .where(isNotNull(schema.catalogueRepos.embedding))
    .orderBy(desc(schema.catalogueRepos.stars))
    .limit(SCAN_CAP);

  const out: AdjacentMatch[] = [];
  const used = new Set<string>();
  for (const a of top) {
    for (const r of repos) {
      const fn = r.fullName.toLowerCase();
      if (excludeFullNames.has(fn) || used.has(fn)) continue;
      if (r.repoShape === "app") continue; // don't pitch a competitor app as exploratory
      if (languagePenalty(projectLanguages, r.primaryLanguage) === Infinity) continue; // runtime-incompatible
      let rcaps: string[] = [];
      try { rcaps = r.capabilities ? JSON.parse(r.capabilities) : []; } catch { /* ignore */ }
      if (!rcaps.map((x) => x.toLowerCase()).includes(a.label.toLowerCase())) continue;
      let topics: string[] = [];
      try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { /* ignore */ }
      if (commodityPenalty(r.name, r.description, topics) > 0) continue; // skip basic commodity libs
      used.add(fn);
      out.push({
        fullName: r.fullName, owner: r.owner, name: r.name, description: r.description,
        url: r.url, stars: r.stars, language: r.primaryLanguage, license: r.license,
        topics, repoShape: r.repoShape, cosine: a.cos, matchedFacet: null, matchedProvenance: null, matchedRepo: null,
        ageDays: r.createdAt ? Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000) : null,
        rising: false,
        adjacentTo: a.nearest, adjacentCapability: a.label,
      });
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}
