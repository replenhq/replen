// Phase 5 — catalogue reader. Matches the shared capability catalogue against a
// scoped project, using the SAME faceted scoring as the per-user pool: best of
// (project centroid, project facets) cosine, with the same relevance floor and
// competitor suppression. So the catalogue surfaces a library that fills one of
// the project's capabilities even when the project's own targeted search hasn't
// fetched it yet — without becoming a trending firehose.

import { db, schema } from "../db/client";
import { desc, isNotNull } from "drizzle-orm";
import { cosineSimilarity, topKmean, parseStoredEmbedding, type FacetEmbedding } from "../lib/embeddings";
import { KEEP_KINDS, RISING_KINDS, type RepoKind } from "./classify";
import { frontierBoost } from "./frontier";
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
  rankCosine?: number; // the rank BASE (= cosine unless top-k-mean aggregation is on); never displayed
  rankPenalty?: number; // reader's value penalties (language + commodity + infra + IDF − provenance bonus), EXCLUDING covered/taste; the merged ranker in the inventory route subtracts this so a commodity/infra match can't leapfrog on raw cosine
  matchedFacet: string | null;
  matchedProvenance: Provenance | null; // how grounded the matched capability is
  matchedRepo: string | null; // sibling repo this is for, when cross-repo (multi-repo products)
  ageDays: number | null;   // repo age; null when unknown
  rising: boolean;          // recent + relevant → "rising in your space"
  tasteAdj?: number;        // Rocchio taste boost applied at ranking time
  vec?: number[];           // the candidate's embedding — for MMR diversity at the output stage
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
// Split floor: a pure-centroid (non-facet-led) match is fuzzier than a grounded
// capability hit, so it must clear a higher bar — drops off-domain whole-project
// lookalikes grazing the floor while facet matches stay at the base. Mirrors the
// inventory route's REPLEN_SEMANTIC_FLOOR_PREMIUM.
const SEMANTIC_FLOOR_PREMIUM = Math.max(0, parseFloat(process.env.REPLEN_SEMANTIC_FLOOR_PREMIUM ?? "0.03"));
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
// A2 lever 1, shared with the inventory route: facet aggregation for the rank
// BASE only. Default 'max' = today. With 'topk-mean' the sort uses the mean of
// the top-K admissible facet cosines; the floor gate + stored cosine stay MAX,
// so the kept set is unchanged. MUST share the flag with route.ts or the two
// candidate paths would rank by different functions.
const FACET_AGG = process.env.REPLEN_FACET_AGG ?? "max";
const FACET_AGG_K = Math.max(1, parseInt(process.env.REPLEN_FACET_AGG_K ?? "3", 10) || 3);

// Returns Infinity (exclude) for hard-incompatible, else a cosine penalty.
function languagePenalty(projectLangs: Set<string>, repoLang: string | null): number {
  if (!repoLang || projectLangs.size === 0) return 0;
  const rl = repoLang.toLowerCase();
  if (projectLangs.has(rl)) return 0;
  if (JS_FAMILY.has(rl) && [...projectLangs].some((l) => JS_FAMILY.has(l))) return 0;
  if (PLATFORM_LOCKED.has(rl)) return Infinity; // can't import it — exclude
  return CROSS_LANG_PENALTY; // sidecar/port-able, but down-rank vs same-language
}

// The frontier prior (age → ranking boost) lives in ./frontier as a pure module
// so this reader and the inventory route's merged ranker share ONE curve. It's a
// WEIGHT, never a gate — see frontier.ts for the full rationale.
// Display-only "rising" flag: young enough to badge as a discovery in the line.
const RISING_MONTHS = Math.max(1, parseInt(process.env.REPLEN_CATALOGUE_RISING_MONTHS ?? "9", 10) || 9);

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
  // Rocchio taste vector (src/lib/taste.ts) — candidates similar to what this
  // project (and its relatives) actually adopted get a small additive boost.
  tasteVec?: number[] | null;
  // Per-facet calibration baselines (label → pool-cosine percentile), computed
  // by the caller from the live candidate pool. A facet-led catalogue match
  // must clear its facet's OWN noise floor by a margin — this is what stops a
  // promiscuous facet ("optimization") pulling a 0.82 disk-cleaner. Empty map →
  // calibration off (back-compat).
  facetBaseline?: Map<string, number>;
}): Promise<CatalogueMatch[]> {
  const { projectEmbedding, projectFacets, minCosine, competitorCentroid, facetLead, excludeFullNames, projectLanguages, knownDeps, coveredFacets, limit, tasteVec, facetBaseline } = opts;
  const TASTE_W = Math.max(0, parseFloat(process.env.REPLEN_TASTE_BOOST ?? "0.05"));
  const FACET_CAL_MARGIN = Math.max(0, parseFloat(process.env.REPLEN_FACET_CAL_MARGIN ?? "0.04"));
  const FACET_IDF_WEIGHT = Math.max(0, parseFloat(process.env.REPLEN_FACET_IDF_WEIGHT ?? "0.06"));
  const idfPen = (label: string | null): number => {
    if (!label || !facetBaseline) return 0;
    const b = facetBaseline.get(label);
    return b === undefined ? 0 : FACET_IDF_WEIGHT * b;
  };
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

    const repoMod = repoModality(r.modality);
    let bestFacet = -Infinity;
    let bestFacetLabel: string | null = null;
    let bestFacetRepo: string | undefined;
    let bestFacetProvenance: Provenance | undefined;
    const catFacetCos: number[] = []; // admissible facet cosines, for the top-k-mean rank base
    for (const f of projectFacets) {
      // Cross-modal gate, applied PER FACET (mirrors the inventory route): a
      // facet whose modality is disjoint from this repo's is a word collision,
      // not a fit — skip it as a probe so another admissible facet or the
      // centroid can still lead. Previously the whole repo was dropped when only
      // its single best facet was cross-modal, unlike the inventory path.
      if (modalitiesDisjoint(f.modality, repoMod)) continue;
      const s = cosineSimilarity(f.vec, emb);
      if (Number.isFinite(s)) catFacetCos.push(s);
      if (Number.isFinite(s) && s > bestFacet) { bestFacet = s; bestFacetLabel = f.label; bestFacetRepo = f.repo; bestFacetProvenance = f.provenance; }
    }

    const cosine = Math.max(cVal, bestFacet);
    // Rank base: top-k-mean over the same facets when the flag is on, else MAX.
    // Used only by score() below; the floor gate + displayed cosine stay on MAX.
    const aggBestFacet = FACET_AGG === "topk-mean" && catFacetCos.length ? topKmean(catFacetCos, FACET_AGG_K) : bestFacet;
    const rankCosine = Math.max(cVal, aggBestFacet);
    const langPen = languagePenalty(projectLanguages, r.primaryLanguage);
    if (langPen === Infinity) continue; // runtime-incompatible — can't use it

    const facetLed = bestFacetLabel !== null && Number.isFinite(bestFacet) && bestFacet >= cVal;
    const matchedFacet = facetLed ? bestFacetLabel : null;
    // (Cross-modal disjoint facets were already skipped as probes above, so the
    // winning facet is admissible by construction — no whole-repo drop here.)

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
    // Per-facet calibration: a facet-led match must beat that facet's own pool
    // noise floor by a margin (not just the global minCosine). Suppresses the
    // promiscuous-facet false positives (disk-cleaner@0.82 on "optimization").
    if (matchedFacet !== null && facetBaseline) {
      const base = facetBaseline.get(matchedFacet);
      if (base !== undefined && cosine < base + FACET_CAL_MARGIN) continue;
    }
    const effective = cosine - langPen - commodityPen - coveredPen - infraPen - idfPen(matchedFacet) + provenanceAdj(matchedProvenance ?? undefined);
    // Split floor: facet-led clears the base; pure-centroid must clear base + premium.
    const floor = facetLed ? minCosine : minCosine + SEMANTIC_FLOOR_PREMIUM;
    if (!Number.isFinite(effective) || effective < floor) continue;

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
    // Taste: small boost for similarity to this project's adopted history.
    let tasteAdj = 0;
    if (tasteVec) {
      const t = cosineSimilarity(tasteVec, emb);
      if (Number.isFinite(t)) tasteAdj = Math.max(0, t) * TASTE_W;
    }
    // Value penalties the ranking applies, bundled for the inventory route's
    // merged ranker (which otherwise ranked catalogue entries on raw cosine and
    // let a commodity/infra match headline). EXCLUDES covered + taste — the
    // route applies those itself, so bundling them here would double-count.
    const rankPenalty = langPen + commodityPen + infraPen + idfPen(matchedFacet) - provenanceAdj(matchedProvenance ?? undefined);
    out.push({
      fullName: r.fullName, owner: r.owner, name: r.name, description: r.description,
      url: r.url, stars: r.stars, language: r.primaryLanguage, license: r.license,
      topics, repoShape: r.repoShape, cosine, rankCosine, rankPenalty, matchedFacet, matchedProvenance, matchedRepo,
      ageDays, rising: recencyEligible && ageDays != null && ageDays <= RISING_MONTHS * 30,
      tasteAdj, vec: emb,
    });
  }

  // Rank by: relevance + frontier + taste − cross-language − commodity − covered
  // − infra. A fresh, non-obvious, DOMAIN gap-filler ranks above a commodity
  // library, an alternative to something you already have, or more plumbing for
  // existing infra. Stars are NOT a penalty — a great high-star niche tool the
  // agent ignores is exactly what we want to surface. The frontier prior applies
  // to EVERY kept match (decaying over 24mo), not just the ≤9mo "rising" badge —
  // so age tilts the whole slate toward what's new without dropping anything.
  const score = (m: CatalogueMatch) =>
    (m.rankCosine ?? m.cosine)
    + (m.tasteAdj ?? 0)
    + frontierBoost(m.ageDays)
    - languagePenalty(projectLanguages, m.language)
    - commodityPenalty(m.name, m.description, m.topics)
    - (m.matchedFacet && isCommodityText(m.matchedFacet) && coveredFacets.has(normLabel(m.matchedFacet)) ? COVERED_PENALTY : 0)
    - (isInfraFacet(m.matchedFacet) ? INFRA_PENALTY : 0)
    - idfPen(m.matchedFacet)
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

  // Project facet vectors by label — used to pick the BEST-FIT repo for an
  // adjacent capability rather than the highest-star one. The catalogue pool is
  // pulled star-desc only as a scan bound; selection below is by embedding fit.
  const facetVecByLabel = new Map<string, number[]>();
  for (const f of projectFacets) facetVecByLabel.set(f.label.toLowerCase(), f.vec);

  const out: AdjacentMatch[] = [];
  const used = new Set<string>();
  for (const a of top) {
    const probeVec = facetVecByLabel.get(a.nearest.toLowerCase()) ?? null;
    // Among repos that genuinely provide this adjacent capability, pick the one
    // whose EMBEDDING fits the project facet best — NOT the highest-star one.
    // Star-ranking let a mega-platform win an ambiguous label ("scheduler" →
    // kubernetes, "embeddings" → rocksdb); fit-ranking keeps the word-sense
    // right and lets a novel niche repo win on relevance.
    let bestRepo: typeof repos[number] | null = null;
    let bestFit = -Infinity;
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
      const rv = probeVec ? parseStoredEmbedding(r.embedding) : null;
      const fit = rv && probeVec ? cosineSimilarity(rv, probeVec) : 0;
      if (fit > bestFit) { bestFit = fit; bestRepo = r; }
    }
    // A shared capability LABEL isn't enough — require the chosen repo to sit
    // genuinely NEAR the project facet (kubernetes "scheduler" embeds nowhere
    // near an in-process job scheduler, so it fails this and is dropped). When
    // there's no probe vec to score against, fall back to the old behaviour.
    if (!bestRepo) continue;
    if (probeVec && bestFit < adjLo) continue;
    const r = bestRepo;
    used.add(r.fullName.toLowerCase());
    let topics: string[] = [];
    try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { /* ignore */ }
    out.push({
      fullName: r.fullName, owner: r.owner, name: r.name, description: r.description,
      url: r.url, stars: r.stars, language: r.primaryLanguage, license: r.license,
      topics, repoShape: r.repoShape, cosine: a.cos, matchedFacet: null, matchedProvenance: null, matchedRepo: null,
      ageDays: r.createdAt ? Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000) : null,
      rising: false,
      adjacentTo: a.nearest, adjacentCapability: a.label,
    });
    if (out.length >= limit) break;
  }
  return out;
}
