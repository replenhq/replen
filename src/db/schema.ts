import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Phase 2: users + per-user settings

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    firebaseUid: text("firebase_uid").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role").notNull().default("user"), // 'admin' | 'user'
    status: text("status").notNull().default("active"), // 'active' | 'suspended'
    // When true, this user's pipeline may fall back to the admin's shared LLM
    // keys (env vars) if they haven't set their own. GitHub token is always BYO.
    canUseSharedLlm: integer("can_use_shared_llm", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
    // Most recent visit to / (dashboard). Used to mark matches as "new since
    // your last visit" with a clear-all button.
    lastViewedAt: integer("last_viewed_at", { mode: "timestamp" }),
    // Most recent /api/mcp/check-new call. Combined with lastViewedAt as
    // max(both) to determine "what's new for this user across all surfaces."
    // Bumped on every MCP/hook check, even when zero new matches qualify.
    lastMcpCheckAt: integer("last_mcp_check_at", { mode: "timestamp" }),
    // Per-user Data Encryption Key (DEK): a random 32-byte AES key, itself
    // encrypted under the master Key Encryption Key (ENCRYPTION_KEY) and
    // stored here as `enc:v1:<iv>:<tag>:<ct>`. All this user's secrets in
    // user_settings are then encrypted under their DEK as `enc:v2:<userId>:<iv>:<tag>:<ct>`.
    // Benefits over a single global key: deleting a user's row destroys
    // access to their secrets (forward secrecy on delete); a leak of one
    // user's secrets doesn't expose another's.
    dekCiphertext: text("dek_ciphertext"),
  },
  (t) => ({
    uniqUid: uniqueIndex("uniq_user_firebase_uid").on(t.firebaseUid),
    uniqEmail: uniqueIndex("uniq_user_email").on(t.email),
  })
);

export const userSettings = sqliteTable(
  "user_settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // Per-user secrets (user's own tokens - never mine)
    githubToken: text("github_token"),
    // Write-scoped GitHub PAT, kept separate so the read-only one used by the
    // pipeline can stay narrowly scoped. Required only for the "create handoff PR" feature.
    githubWriteToken: text("github_write_token"),
    // Legacy per-provider columns. Kept for backward compatibility with rows
    // written before the generic slots existed. Read paths fall back to these
    // when the generic columns are null; writes go to the generic columns only.
    deepseekApiKey: text("deepseek_api_key"),
    anthropicApiKey: text("anthropic_api_key"),
    // Generic LLM slot config. Provider-agnostic: the same fields work for any
    // OpenAI-compatible endpoint plus Anthropic's /v1/messages (toggle via
    // llmSensitiveWireFormat). API keys are encrypted at rest.
    //   Primary slot   - used for triage + low-sensitivity reasoning.
    //   Sensitive slot - only used for project_profiles.sensitivity = 'high'.
    llmPrimaryApiKey: text("llm_primary_api_key"),
    llmPrimaryBaseUrl: text("llm_primary_base_url"),
    llmPrimaryModel: text("llm_primary_model"),
    llmSensitiveApiKey: text("llm_sensitive_api_key"),
    llmSensitiveBaseUrl: text("llm_sensitive_base_url"),
    llmSensitiveModel: text("llm_sensitive_model"),
    // 'anthropic' (default — Anthropic /v1/messages) or 'openai-compatible'
    // (route through /chat/completions, for e.g. a privately-hosted model).
    llmSensitiveWireFormat: text("llm_sensitive_wire_format"),
    // Comma-separated extra doc paths (relative to each project root) for the
    // loader to read alongside the built-in defaults. Globs like
    //   docs/architecture/*.md,SPEC/**/*.md,replen-context.md
    // are accepted. Useful when a project's important context lives outside
    // the default doc-file list (README, CLAUDE.md, SPEC.md, etc).
    extraDocPaths: text("extra_doc_paths"),
    // Sources
    threadsHandles: text("threads_handles"), // comma-separated
    redditSubs: text("reddit_subs"), // comma-separated
    tiktokHandles: text("tiktok_handles"), // comma-separated
    // Email destination (where their digest goes - sender is shared via SES domain)
    emailToAddress: text("email_to_address"),
    // Run prefs
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    cronHourUtc: integer("cron_hour_utc").notNull().default(6),
    // Soft cost cap - if the user's runs in the last 24h totalled more than
    // this many USD, the next run is skipped with a `paused_reason` of
    // 'cost-cap'. 0 disables the cap. Default $5/day.
    dailyCostCapUsd: real("daily_cost_cap_usd").notNull().default(5.0),
    // Webhook for real-time alerts on `relevance=high` matches. POSTs a JSON
    // payload (Slack/Discord compatible) at the end of each run.
    webhookUrl: text("webhook_url"),
    webhookKind: text("webhook_kind").notNull().default("generic"), // 'slack' | 'discord' | 'generic'
    // Personal token for the /api/ingest endpoint (and MCP /api/mcp/*). Lets
    // a user POST from a bookmarklet / browser extension / MCP server into
    // their account without going through full Firebase auth. The plaintext
    // is shown to the user once at generation/rotation and never persisted;
    // only the sha256 hash is stored for lookup.
    ingestTokenHash: text("ingest_token_hash"),
    // 90-day expiry stamped at issue time by authorizeCli. Auth middleware
    // refuses redemption once now() > this. Forces periodic re-auth and
    // means a leaked token has a bounded blast radius. Nullable for legacy
    // rows pre-0028; those are treated as non-expiring (back-compat).
    ingestTokenExpiresAt: integer("ingest_token_expires_at", { mode: "timestamp" }),
    // Updated by the auth middleware on every successful redemption.
    // Surfaced on /settings so users notice tokens that haven't been used
    // (revoke unused) or that are being used at weird hours (revoke
    // suspicious).
    ingestTokenLastUsedAt: integer("ingest_token_last_used_at", { mode: "timestamp" }),
    // Comma-separated primary languages auto-detected from the user's own
    // repos when they save a PAT (e.g. "TypeScript,Python,Go"). Used by the
    // gh-trending fetcher to pull language-specific trending pages instead
    // of a hardcoded list - most content creators are just repackaging
    // gh-trending, so widening that lens is high-leverage.
    detectedLanguages: text("detected_languages"),
    // Skill-mode pivot: which pre-filter the inventory endpoint applies.
    // 'zero-knowledge' = full firehose, 'tags' = project-tag intersection
    // (default), 'fingerprint' = LSH-style similarity on a project shape
    // hash (opt-in). User-settable in /settings.
    filterMode: text("filter_mode").notNull().default("tags"),
    // 'skill' (in-CLI, subscription tokens, default) | 'hosted' (legacy
    // hosted pipeline with BYO API keys, for non-CLI users). Determines
    // which code path the pipeline runs for a given user.
    subscriptionTier: text("subscription_tier").notNull().default("skill"),
    // Immersion: how deeply Replen grounds on a project's actual code, as an
    // account default ('off' | 'embeddings' | 'full-code'). Per-repo override on
    // project_profiles.immersion_tier. Self-host defaults ON via the
    // REPLEN_SELF_HOST env flag (not this column) — see src/lib/immersion-tier.ts.
    immersionTier: text("immersion_tier").notNull().default("off"),
    // Always-on layer: the weekly "four questions" brief (what'll break /
    // security / bill / upgrades, for YOUR stack). Sent only when something
    // qualified — a quiet week sends nothing.
    weeklyBriefEnabled: integer("weekly_brief_enabled", { mode: "boolean" }).notNull().default(true),
    // Granular email preferences (customisable in the account settings UI; the
    // signed unsubscribe links flip the relevant one). `enabled` stays the master
    // kill-switch; these scope individual channels.
    //   digestEnabled        — the per-run "new matches" digest (high/medium only)
    //   securityAlertsEnabled — out-of-band critical security alerts
    //   briefFrequency        — cadence of the weekly four-questions brief:
    //                           'weekly' | 'biweekly' | 'monthly' | 'off'
    digestEnabled: integer("digest_enabled", { mode: "boolean" }).notNull().default(true),
    securityAlertsEnabled: integer("security_alerts_enabled", { mode: "boolean" }).notNull().default(true),
    briefFrequency: text("brief_frequency").notNull().default("weekly"),
    // Silent auto-reground master switch. Default ON: the in-session agent
    // silently re-derives a repo's grounded capabilities (in a background
    // subagent) when they drift from live code or fall behind the grounding
    // schema (see needsReground / the injected instruction). Set false to opt
    // out entirely — the server then never emits needsReground and onboarding
    // reverts to the consent offer. `npx replen autoground off` flips it.
    autogroundEnabled: integer("autoground_enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqUser: uniqueIndex("uniq_settings_user").on(t.userId),
    uniqIngestHash: uniqueIndex("uniq_settings_ingest_hash").on(t.ingestTokenHash),
  })
);

// Admin-curated shared sources. Fetchers merge these with each user's own settings.
export const curatedSources = sqliteTable(
  "curated_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(), // 'threads' | 'reddit' | 'rss' | 'other'
    value: text("value").notNull(),
    label: text("label"),
    addedByUserId: integer("added_by_user_id").references(() => users.id),
    proposalId: integer("proposal_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqKindValue: uniqueIndex("uniq_curated_kind_value").on(t.kind, t.value),
  })
);

export const proposedSources = sqliteTable(
  "proposed_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'threads' | 'reddit' | 'rss' | 'other'
    value: text("value").notNull(), // e.g. handle, subreddit, URL
    note: text("note"),
    status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
    reviewedByUserId: integer("reviewed_by_user_id").references(() => users.id),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
    adminNote: text("admin_note"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxStatus: index("idx_proposal_status").on(t.status),
    idxUser: index("idx_proposal_user").on(t.userId),
  })
);

export const candidates = sqliteTable(
  "candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceItemId: text("source_item_id").notNull(),
    title: text("title"),
    url: text("url").notNull(),
    githubUrl: text("github_url"),
    author: text("author"),
    score: integer("score"),
    postedAt: integer("posted_at", { mode: "timestamp" }),
    fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
    rawJson: text("raw_json"),
    // Pipeline v2 / Sprint 1: inventory-level metadata so Stage 2 can
    // run cheap eligibility filters (language family, repo shape) before
    // the expensive scoring stage. See docs/pipeline-v2.md.
    primaryLanguage: text("primary_language"),
    topics: text("topics"),       // JSON array of strings
    repoShape: text("repo_shape"), // library | framework | app | template | tutorial | aggregator | unknown
    // Semantic embedding of the candidate's surface signal (title +
    // description + topics + repo shape) using OpenAI
    // text-embedding-3-small. JSON-serialised number[] of length 1536.
    // Used by /api/inventory/today to rank candidates by cosine
    // similarity against the project's embedding, instead of bag-of-
    // tags intersection. Null until the embedding pass runs; lazy-
    // backfilled at query time when a query hits a candidate without
    // one.
    //
    // Why store as JSON rather than BLOB: SQLite has no native vector
    // type, JS-side cosine similarity is fine for ~hundreds of vectors
    // per query (microseconds), and JSON keeps inspection trivial.
    // 1536 floats × ~10 chars each ≈ 15 KB per row — acceptable.
    embedding: text("embedding"),
    // sha256 of the text that was embedded. Lets us skip re-embedding
    // when the candidate's surface signal hasn't changed.
    embeddingContentHash: text("embedding_content_hash"),
    embeddingGeneratedAt: integer("embedding_generated_at", { mode: "timestamp" }),
    // Candidate-side enrichment (parity with the catalogue, which already carries
    // these). Title+description alone was the retrieval ceiling (~50 words); a
    // README head lifts it, and a deterministic topic→modality lets the modality
    // gate fire on the fetcher pool too (not just the catalogue). See
    // src/fetchers/index.ts (population) + inventory route (gate).
    readmeHead: text("readme_head"),       // cleaned first ~1.5k chars of the repo README
    modality: text("modality"),            // JSON Modality[] from topics (modalityFromTopics)
    // Candidate-side parity with the catalogue: the cheap classifier's one-sentence
    // capability descriptor (leads the embedding text — un-blinds the discovered pool
    // from a title+desc blur) and its kind (library/framework/app/experiment/content;
    // more reliable than the heuristic repo_shape). NULL = not yet classified (abstain).
    capabilitySummary: text("capability_summary"),
    classifierKind: text("classifier_kind"),
  },
  (t) => ({
    uniqSourceItem: uniqueIndex("uniq_source_item_user").on(t.userId, t.source, t.sourceItemId),
    idxGithub: index("idx_candidates_github").on(t.githubUrl),
    idxUser: index("idx_candidates_user").on(t.userId),
    // The hot per-session inventory pull is WHERE user_id = ? AND fetched_at >= ?
    // ORDER BY ... fetched_at DESC. idx_candidates_user (user_id only) can't serve
    // the fetched_at range/sort, so it scanned the user's entire candidate history.
    idxUserFetched: index("idx_candidates_user_fetched").on(t.userId, t.fetchedAt),
  })
);

export const repos = sqliteTable(
  "repos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    stars: integer("stars"),
    forks: integer("forks"),
    license: text("license"),
    primaryLanguage: text("primary_language"),
    pushedAt: integer("pushed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }),
    defaultBranch: text("default_branch"),
    readmeMd: text("readme_md"),
    readmeSha: text("readme_sha"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    // Repo identity is case-insensitive: GitHub owner/name are ASCII and
    // case-insensitive, so "Owner/Repo" and "owner/repo" are the
    // same repo. The unique key is on lower(owner)/lower(name); original casing
    // is preserved in the columns for display. Migration 0077 does the one-time
    // merge of pre-existing case-variant duplicates and swaps the old
    // case-sensitive `uniq_repo` for this index.
    uniqRepoCi: uniqueIndex("uniq_repo_ci").on(sql`lower(${t.owner})`, sql`lower(${t.name})`),
  })
);

export const safetyScans = sqliteTable("safety_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
  scannedAt: integer("scanned_at", { mode: "timestamp" }).notNull(),
  postinstallHooks: text("postinstall_hooks"),
  suspiciousPatterns: text("suspicious_patterns"),
  ageDays: integer("age_days"),
  daysSincePush: integer("days_since_push"),
  contributorCount: integer("contributor_count"),
  starVelocity: real("star_velocity"),
  secretsFound: integer("secrets_found", { mode: "boolean" }).default(false),
  riskLevel: text("risk_level"),
  notes: text("notes"),
});

export const projectProfiles = sqliteTable(
  "project_profiles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    // Real on-disk directory of the local checkout (nullable). `path` above is
    // the synthetic identity ("github:owner/name"); local_path is where the
    // files actually live, used ONLY by self-host Immersion to read code off
    // disk. Carried up from the CLI's discovery at register time.
    localPath: text("local_path"),
    // Per-repo Immersion override ('off' | 'embeddings' | 'full-code'); null =
    // inherit the account default (user_settings.immersion_tier).
    immersionTier: text("immersion_tier"),
    name: text("name").notNull(),
    // GitHub/manifest-detected primary language (e.g. "typescript", "python").
    // Sent at registration; fed into the project centroid as a soft language
    // signal (see projectEmbeddingText). NULL until a registration reports it.
    primaryLanguage: text("primary_language"),
    readmeMd: text("readme_md"),
    claudeMd: text("claude_md"),
    techSummary: text("tech_summary"),
    // Agentic onboarding: the user's coding agent's grounded project report —
    // a comprehensive code-read write-up (what it does, tech, algos, how/why,
    // architecture, for whom). Richer than the docs (it reflects what the agent
    // KNOWS from reading the source), and an additional input to the server's
    // safety-net summarization. NULL until the onboarding sweep runs.
    agentReport: text("agent_report"),
    // Version reporting: JSON Record<depName, version> sent by the in-session
    // agent from the lockfile/manifest (names + versions ONLY, never code).
    // Runtimes use canonical keys (node, python, postgres, …). Turns "worth
    // checking your pins" into "affects acme (3.10.12)" across deadlines,
    // alerts, and the weekly brief. NULL until the agent reports.
    depVersions: text("dep_versions"),
    // Sprint 5 loader expansion: structured project-shape blob captured at
    // loader time. JSON object: { fileTree: string[], structured: string }.
    // - fileTree: sorted repo paths (denylist-filtered, lockfiles + build
    //   artefacts excluded). Fed to the Stage-1 summarizer as ground-truth
    //   project shape (trusted over prose docs). NOTE: an earlier comment
    //   claimed the scorer existence-prunes candidates that duplicate code you
    //   already have — that was never implemented; fileTree is summarizer input
    //   only.
    // - structured: concatenated non-markdown signal files (prisma schema,
    //   migrations, Mermaid/PlantUML diagrams, runtime configs). Captures
    //   architecture detail the markdown blob misses.
    // NULL on existing rows = loader hasn't refreshed yet; treated as
    // "no shape data" by summarize.ts. Repopulated next loader pass.
    shapeJson: text("shape_json"),
    // Comma-separated GitHub-topic-style keywords derived once from the
    // profile docs (e.g. "computer-vision,object-detection,supervision-lib").
    // Used by the gh-search fetcher to surface niche-relevant repos beyond
    // trending feeds. Re-derived when profileHash changes; user-overridable.
    searchKeywords: text("search_keywords"),
    profileHash: text("profile_hash").notNull(),
    // Stage-1 structured project understanding. JSON blob conforming to the
    // ProjectSummary type in src/projects/summarize.ts. Cached. Regenerated
    // when profileHash changes, summary_generated_at is > 3 days old, or the
    // prompt_version constant in the codebase has been bumped past what's
    // recorded here. Feeds Stage-2 gap analysis (active scouting) — see
    // docs/active-scouting-plan.md and docs/stage-1-scope.md.
    summaryJson: text("summary_json"),
    summaryHash: text("summary_hash"),
    summaryGeneratedAt: integer("summary_generated_at", { mode: "timestamp" }),
    summaryPromptVersion: text("summary_prompt_version"),
    // Stage-2 search vectors. JSON blob conforming to ProjectSearchVectors in
    // src/projects/search-vectors.ts. Cached. Regenerated when summaryHash
    // changes, the 7-day ceiling expires, or VECTORS_PROMPT_VERSION bumps.
    // Feeds Stage-3 (targeted GitHub search) — see docs/stage-2-scope.md.
    searchVectorsJson: text("search_vectors_json"),
    searchVectorsSummaryHash: text("search_vectors_summary_hash"),
    searchVectorsGeneratedAt: integer("search_vectors_generated_at", { mode: "timestamp" }),
    searchVectorsPromptVersion: text("search_vectors_prompt_version"),
    // Initiative #1: activity-aware matching. JSON blob conforming to
    // ProjectActivitySummary in src/projects/activity-summary.ts. Captures
    // what the user has been ACTIVELY building (recent commits, open PRs,
    // touched files, TODO clusters) so the LLM can grade matches against
    // current work, not just the project's general doc shape.
    // Refresh policy: re-probe when activityHeadSha != current git HEAD,
    // OR when activityGeneratedAt is > 24h old.
    activityJson: text("activity_json"),
    activityGeneratedAt: integer("activity_generated_at", { mode: "timestamp" }),
    activityHeadSha: text("activity_head_sha"),
    // Initiative #2: per-project cached dep health probe. JSON blob keyed
    // by ecosystem-qualified dep name ("npm:moment", "cargo:serde") with
    // upstream-health metadata (last_push, archived, etc.). Refreshed
    // weekly because deps don't go stale daily; faster TTL would just
    // burn GH API quota.
    depHealthJson: text("dep_health_json"),
    depHealthGeneratedAt: integer("dep_health_generated_at", { mode: "timestamp" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    included: integer("included", { mode: "boolean" }).notNull().default(true),
    sensitivity: text("sensitivity").notNull().default("low"),
    // 'auto' (use sensitivity routing) | 'deepseek' | 'anthropic'
    llmProvider: text("llm_provider").notNull().default("auto"),
    // GitHub "owner/name" of this project's own repo. Used by the
    // "create handoff PR" feature to know where to commit. Optional.
    githubFullName: text("github_full_name"),
    // Multi-repo products: repos sharing a productKey ("owner/stem") are one
    // product. When scoped to any of them, matching unions the whole product's
    // capabilities, so a CV library surfaces in acme-web (where you work), not
    // only in acme-cv (which you never open). Auto-derived; user-overridable.
    productKey: text("product_key"),
    // Skill-mode filter B: user-curated tag list for the inventory
    // pre-filter. JSON array of strings (e.g. ["typescript", "next.js",
    // "news", "social-syndication"]). Auto-suggested at project-onboard
    // time from the project shape; user-editable in /settings.
    tags: text("tags"),
    // RESERVED / UNUSED. Was specced as skill-mode filter C — an opaque
    // LSH-style shape hash (file-tree fingerprint + dep-set MinHash) for a
    // similarity pre-filter — but the 'fingerprint' filter mode was never
    // implemented (the inventory route normalises it to 'tags'). Nothing reads
    // this column; kept only to avoid a destructive migration.
    fingerprintHash: text("fingerprint_hash"),
    // Semantic embedding of the project's profile (summary statement +
    // outcome goals + tags + name + niche) using OpenAI text-embedding-
    // 3-small. JSON number[1536]. Used as the query vector against
    // candidates.embedding for semantic shortlisting. Recomputed when
    // embeddingContentHash diverges from the current project content
    // (cheap: ~$0.000005 per regen, infrequent in practice).
    embedding: text("embedding"),
    embeddingContentHash: text("embedding_content_hash"),
    embeddingGeneratedAt: integer("embedding_generated_at", { mode: "timestamp" }),
    // Faceted matching (Phase 1). The single `embedding` above is the project
    // CENTROID — it blends every capability into one point and therefore
    // matches whole-apps in the same domain (competitors) rather than the
    // libraries that fill a specific capability. `facetEmbeddings` stores one
    // vector PER capability ({label, vec}) so a candidate can match on its
    // BEST facet (a CV library matches the "computer vision" facet even though
    // it's nowhere near the centroid). JSON: { hash, facets: [{label, vec[]}] }.
    facetEmbeddings: text("facet_embeddings"),
    // Domain-anchor: an embedding of the project's domain TAGS alone (not the
    // blended centroid) — the "is this candidate in my subject area?" vector that
    // powers the soft subject-area prior (matching precision). Rebuilt with the
    // centroid when tags change; backfilled lazily on the next pipeline run when null.
    domainAnchor: text("domain_anchor"),
    // Last time the skill/MCP asked for THIS repo's inventory (a "repo open").
    // Drives the since-last-open discovery window: the inventory route widens
    // its default fetchedAt window to cover everything found since the user last
    // looked here, floored at the steady window and capped at the first-run
    // width. Null = never queried -> first-run width. Written per scoped query.
    lastQueriedAt: integer("last_queried_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqSlug: uniqueIndex("uniq_profile_user_slug").on(t.userId, t.slug),
    idxUser: index("idx_profile_user").on(t.userId),
  })
);

// Skill-mode per-(user, repo, project) lifecycle state. Replaces what
// the legacy `matches` table tracks for hosted-tier users. In skill
// mode the agent produces writeups in-session and they NEVER persist
// server-side (privacy property — no user code or generated text
// leaves the user's machine). We only track outcomes here: that a repo
// was surfaced, that the user starred/hid it, that a handoff PR was
// opened. Same repo can appear in two project contexts with
// independent state.
export const userMatchState = sqliteTable(
  "user_match_state",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    // Nullable: a repo can be surfaced in a "global" (no specific
    // project) context too. setNull on project delete so the row
    // outlives a removed project.
    projectId: integer("project_id").references(() => projectProfiles.id, { onDelete: "set null" }),
    // 'surfaced' (the inventory served it; default initial state),
    // 'starred' (user explicitly bookmarked), 'hidden' (user
    // dismissed; never resurface), 'handed_off' (handoff PR opened
    // against this repo). Lifecycle is monotonic except hidden which
    // can be cleared by user action in /settings.
    status: text("status").notNull(),
    // For 'surfaced' rows this is the MOST-RECENT surfacing time (bumped on
    // each re-surface), so the inventory can apply a cool-off window. For
    // terminal statuses (starred/hidden/handed_off) it's effectively the
    // last time we touched the row. Indexed for recency ordering.
    surfacedAt: integer("surfaced_at", { mode: "timestamp" }).notNull(),
    // How many times the inventory has surfaced this repo to the user without
    // them acting on it. Drives the "shown N times → cool off / stop" rule so
    // repeat users don't see the same footnote candidate every session.
    // Incremented on each 'surfaced' record; left as-is on terminal actions.
    surfacedCount: integer("surfaced_count").notNull().default(0),
    actionAt: integer("action_at", { mode: "timestamp" }),
    handoffPrUrl: text("handoff_pr_url"),
    userNote: text("user_note"),
  },
  (t) => ({
    uniqUserRepoProject: uniqueIndex("uniq_user_match_state_repo_project").on(t.userId, t.repoId, t.projectId),
    // The full index above can't enforce uniqueness for global (project_id IS
    // NULL) rows — SQLite treats NULLs as distinct — so concurrent writes could
    // mint duplicate (user, repo, NULL) rows. This partial unique index closes
    // that: at most one global row per (user, repo). The upsert paths target it
    // with a matching `WHERE project_id IS NULL`.
    uniqUserRepoNullProject: uniqueIndex("uniq_user_match_state_repo_null_project").on(t.userId, t.repoId).where(sql`${t.projectId} is null`),
    idxUserStatus: index("idx_user_match_state_user_status").on(t.userId, t.status),
    idxUserSurfaced: index("idx_user_match_state_surfaced").on(t.userId, t.surfacedAt),
  })
);

// Append-only event log of agent-side triage decisions. Each row =
// "the agent considered candidate X for project Y, verdict was Z,
// here's a one-line summary." Posted by the /replen-match skill via
// the replen_record_triage MCP tool. Distinct from user_match_state
// (which is the user's monotonic action state) — this is the agent's
// running journal, multi-event by design.
//
// Why a separate table:
//   - user_match_state is unique on (user, repo, project); triage_events
//     allows multiple rows so the agent can re-evaluate the same
//     candidate in different sessions.
//   - Verdicts ('adopt' / 'port' / 'skip' / 'defer') are the agent's
//     view; user actions ('starred' / 'hidden' / 'handed_off') are the
//     user's view. They can disagree (agent said adopt, user starred
//     anyway; agent said skip, user starred). Both are interesting.
//   - The Activity feed on / merges both streams ordered by timestamp.
export const triageEvents = sqliteTable(
  "triage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    projectId: integer("project_id").references(() => projectProfiles.id, { onDelete: "set null" }),
    // 'adopt' | 'port' | 'skip' | 'defer'. The agent's structured call
    // on whether this candidate belongs in the user's stack.
    verdict: text("verdict").notNull(),
    // 0-100, agent-assigned. Nullable so the skill can record a
    // "considered but no score" event.
    score: integer("score"),
    // 'quick' (<1d) | 'moderate' (1-3d) | 'deep' (1+w). Nullable.
    effortBand: text("effort_band"),
    // The capability facet this candidate matched on, the facet's modality (JSON
    // Modality[]), and a structured reason for the verdict ('fit' |
    // 'modality-collision' | 'task-collision' | 'covered' | 'wrong-posture' |
    // 'low-quality' | 'other'). Powers the CONTEXTUAL learning loop: suppress a
    // (repo × modality) collision without globally demoting the repo. Nullable.
    matchedFacet: text("matched_facet"),
    facetModality: text("facet_modality"),
    reasonCode: text("reason_code"),
    // The cosine this candidate surfaced at (from replen_match data). Paired
    // with the verdict it becomes a labeled example for calibrating the
    // relevance floor per project. Nullable — older events lack it.
    matchedCosine: real("matched_cosine"),
    // Short summary the agent wrote for the user. Like a commit subject.
    oneLine: text("one_line"),
    // Optional full reasoning. Can be 0-5KB. Replen stores this server-
    // side because it's the agent's *output about a public repo* — no
    // user source code in it. Useful for the Activity feed to show
    // "click to see why".
    writeup: text("writeup"),
    // Groups events from the same Claude Code session. Lets the
    // Activity feed cluster "agent triaged 5 candidates Tuesday" as
    // one collapsible block. CLI-assigned, opaque to the server.
    sessionId: text("session_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxUserCreated: index("idx_triage_events_user_created").on(t.userId, t.createdAt),
    idxUserRepo: index("idx_triage_events_user_repo").on(t.userId, t.repoId),
    idxSession: index("idx_triage_events_session").on(t.userId, t.sessionId),
  })
);

// Portfolio insight captures from the multi-vector triage (Passes 3-4): a
// transferable idea/premise/way-of-working ('lesson') or a sharpened boundary
// ('boundary') extracted from a candidate — recorded EVEN WHEN the candidate is
// a direct-use skip (the Graphify→Atlas lane). Distinct from triage_events (a
// per-candidate use-verdict): an insight is a PORTFOLIO decision, not a fitness
// call. The graph build reads these into 'lesson'/'boundary' nodes with a `via`
// provenance edge; Atlas renders them as tiles. Recorded by the /replen skill
// via the replen_capture_insight MCP tool. High bar — only decision-changing,
// Graphify-grade insights, never "vaguely interesting".
export const triageInsights = sqliteTable(
  "triage_insights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // 'lesson' (transferable idea/premise/way-of-working) |
    // 'boundary' (something we're now explicitly NOT, sharpened by seeing this).
    kind: text("kind").notNull(),
    // The insight itself — one or two sentences, the user-legible takeaway.
    text: text("text").notNull(),
    // The candidate that prompted it (the `via` of the provenance path).
    // Nullable + set-null so the insight outlives the repo row.
    viaCandidateRepoId: integer("via_candidate_repo_id").references(() => repos.id, { onDelete: "set null" }),
    // The project this insight could touch / influenced (e.g. Graphify→Atlas).
    // Nullable: an insight can be portfolio-wide.
    appliesToProjectId: integer("applies_to_project_id").references(() => projectProfiles.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxUserCreated: index("idx_triage_insights_user_created").on(t.userId, t.createdAt),
    idxUserKind: index("idx_triage_insights_user_kind").on(t.userId, t.kind),
  })
);

// Cross-user, cross-tenant quality aggregate for a candidate repo. One row
// per repo, materialised from triage_events across ALL users (each user
// counted ONCE by their LATEST verdict on the repo, so a single user
// re-evaluating doesn't inflate the signal). Recomputed on every triage
// write (see src/lib/repo-quality.ts) and backfillable via
// src/cli/backfill-repo-quality.ts.
//
// Powers the learning loop in the inventory endpoint:
//   - global demote: a repo whose latest-verdict skip ratio is high across
//     enough distinct users is suppressed for EVERYONE — many people judged
//     it rubbish, so stop surfacing it.
//   - similar-project promote: a repo with positive verdicts (adopt/port)
//     becomes eligible to surface to a DIFFERENT user whose project is
//     embedding-similar to one the repo scored well for.
//
// Privacy: this is an aggregate of derived signals (verdict tallies, avg
// score). It never stores or exposes another user's identity, project, or
// writeup — only the public repo and how it fared in aggregate.
export const repoQuality = sqliteTable(
  "repo_quality",
  {
    repoId: integer("repo_id").primaryKey().references(() => repos.id, { onDelete: "cascade" }),
    // Per-user LATEST-verdict tallies (each distinct user contributes 1).
    adoptUsers: integer("adopt_users").notNull().default(0),
    portUsers: integer("port_users").notNull().default(0),
    skipUsers: integer("skip_users").notNull().default(0),
    deferUsers: integer("defer_users").notNull().default(0),
    // Distinct users who have ever triaged this repo (= sum of the four).
    totalUsers: integer("total_users").notNull().default(0),
    // Mean agent score across the latest-verdict events that carried a score.
    avgScore: real("avg_score"),
    lastTriagedAt: integer("last_triaged_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxSkip: index("idx_repo_quality_skip").on(t.skipUsers, t.totalUsers),
    idxPositive: index("idx_repo_quality_positive").on(t.adoptUsers, t.portUsers),
  })
);

export const matches = sqliteTable(
  "matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    projectId: integer("project_id").references(() => projectProfiles.id, { onDelete: "cascade" }),
    runId: integer("run_id").notNull(),
    relevance: text("relevance").notNull(),
    relevanceScore: integer("relevance_score"),
    summary: text("summary"),
    whyUseful: text("why_useful"),
    suggestedUse: text("suggested_use"),
    integrationApproach: text("integration_approach"),
    // Pipeline v2 Sprint 4: LLM-estimated effort to actually do this
    // match. One of "quick" (<1d), "moderate" (1-3d), "deep" (1+ week),
    // or null when not estimated. Lets the user pick what to act on
    // TODAY vs what to queue. See src/db/migrations/0035_match_effort_band.sql.
    effortBand: text("effort_band"),
    risks: text("risks"),
    writeupMd: text("writeup_md"),
    // 'unread' | 'starred' | 'bookmarked' | 'hidden'. 'starred' = "action
    // item" (only valid on high/medium relevance); 'bookmarked' = "save for
    // later" (only valid on general-awareness). The split is enforced in
    // setMatchStatus (src/app/actions.ts) and lets the bookmark resurface
    // logic key off `userStatus = 'bookmarked'` directly instead of joining
    // on relevance. See docs/bookmark-resurface-scope.md.
    userStatus: text("user_status").notNull().default("unread"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    // URL of the GitHub PR opened by the "create handoff" action. Non-null
    // means a handoff already exists and we shouldn't open a duplicate.
    handoffPrUrl: text("handoff_pr_url"),
    handoffCreatedAt: integer("handoff_created_at", { mode: "timestamp" }),
    // Cached PR state polled from GitHub: 'open' | 'closed' | 'merged'.
    handoffPrStatus: text("handoff_pr_status"),
    handoffPrCheckedAt: integer("handoff_pr_checked_at", { mode: "timestamp" }),
    // Set when the handoff PR is merged - marks this OSS as actually integrated.
    integratedAt: integer("integrated_at", { mode: "timestamp" }),
    // Free-form personal note (used mostly on _general matches as "revisit if
    // I ever build X").
    personalNote: text("personal_note"),
    // Per-match useful/not-useful signal. Separate from userStatus because
    // "star" means "I want to action this" while feedback means "was this a
    // good recommendation". Aggregated later to weight sources by hit-rate.
    userFeedback: text("user_feedback"), // 'good' | 'bad' | null
    // Snapshot of which source surfaced this repo at the time the match was
    // shown. Denormalised onto the row so per-source feedback aggregation
    // stays cheap (no join through candidates needed).
    sourceKind: text("source_kind"),
    // Soft-delete timestamp - set by aging policy on old hidden matches so
    // the dashboard skips them without losing the history outright.
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    // Stage-4 attribution. Set only for matches produced from gh-targeted
    // candidates (the targeted-search path). The UI surfaces this as
    // "Replen found this because you said you want <outcome>" so users
    // can see why a given repo surfaced. Null for general (HN/Reddit/
    // trending) matches, which don't have outcome-level attribution.
    matchedOutcome: text("matched_outcome"),
    matchedOutcomeSource: text("matched_outcome_source"), // 'user' | 'inferred'
    matchedOutcomeConfidence: text("matched_outcome_confidence"), // 'high' | 'medium'
    // How this match entered the user's digest:
    //   'scouted'    — Stage 3/4 outcome attribution (was: 'targeted')
    //   'discovered' — broad-net fetcher (HN, reddit, trending, etc.) with
    //                  no outcome attribution (was: 'serendipity')
    //   're-checked' — resurfaced from the user's starred general-awareness
    //                  pile against a different project (was: 'bookmark')
    //   'manual'     — direct user push (bookmarklet, MCP, /api/ingest);
    //                  reserved, not yet used by any insert path.
    // Renamed 2026-05-18 by migration 0027 to use plainer English vocabulary
    // on the UI pill. See docs/stage-5-scope.md and docs/bookmark-resurface-scope.md.
    discoveryMode: text("discovery_mode"), // 'scouted' | 'discovered' | 're-checked' | 'manual' | 'prune'
    // Resurface back-link: when a bookmarked general-awareness match
    // re-surfaces as a fit for a different project, the new row references
    // the original starred match. The UI uses this to render the "saved on
    // <date>" chip linking back to the bookmark.
    resurfacedFromMatchId: integer("resurfaced_from_match_id"),
    // Initiative #2: prune matches recommend dropping or replacing one of
    // the project's existing dependencies. repoId points at the suggested
    // replacement (or the targeted dep's own repo when the action is just
    // "drop"). These columns identify which dep is being targeted so the
    // UI can render it and the handoff PR can write the right `npm
    // uninstall` / `cargo remove` / etc. command. Null for non-prune
    // matches.
    prunedDepName: text("pruned_dep_name"),
    prunedDepEcosystem: text("pruned_dep_ecosystem"), // 'npm' | 'python' | 'cargo' | 'go'
    prunedDepAction: text("pruned_dep_action"),       // 'drop' | 'replace'
    prunedDepVersion: text("pruned_dep_version"),     // raw version string from the manifest
    // Pipeline v2 / Sprint 2 — name of the package this match suggests
    // as a replacement (when prunedDepAction == 'replace'). Required for
    // cross-match consistency detection: if match A says "drop fluent-
    // ffmpeg" and match B says "replace @ffmpeg-installer with fluent-
    // ffmpeg" we now have the structured signal to detect that.
    prunedDepReplacement: text("pruned_dep_replacement"),
  },
  (t) => ({
    idxRepoProject: index("idx_match_repo_project").on(t.repoId, t.projectId),
    idxRun: index("idx_match_run").on(t.runId),
    idxUser: index("idx_match_user").on(t.userId),
  })
);

// Persistent BM25 code index over a candidate OSS repo's source. One row per
// (repo, index_version) — the version is bumped whenever the chunking or
// tokenisation algorithm changes, forcing a clean rebuild without touching
// older rows. readme_sha pins the index to a specific README hash so a repo
// that gets re-fetched with new content invalidates the index automatically.
// See docs/repo-indexer-scope.md.
export const repoIndexes = sqliteTable(
  "repo_indexes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    readmeSha: text("readme_sha"),
    builtAt: integer("built_at", { mode: "timestamp" }).notNull(),
    chunkCount: integer("chunk_count").notNull(),
    byteCount: integer("byte_count").notNull(),
    indexVersion: text("index_version").notNull(),
    totalTokens: integer("total_tokens").notNull(),
  },
  (t) => ({
    uniqRepoVersion: uniqueIndex("uniq_repo_index_version").on(t.repoId, t.indexVersion),
    idxBuilt: index("idx_repo_indexes_built").on(t.builtAt),
  })
);

// One row per code chunk. file_path is repo-relative ("src/lib/foo.ts").
// doc_length is the BM25 token count, pre-computed so BM25 scoring doesn't
// re-tokenise content on every query. Content is materialised at index time
// and never re-fetched from the original repo (the clone is throwaway).
export const repoChunks = sqliteTable(
  "repo_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    indexId: integer("index_id").notNull().references(() => repoIndexes.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    language: text("language"),
    content: text("content").notNull(),
    docLength: integer("doc_length").notNull(),
  },
  (t) => ({
    idxIndex: index("idx_repo_chunks_index").on(t.indexId),
  })
);

// Inverted index: (term -> chunk_id, freq). Queried at search time as
// `SELECT chunk_id, freq FROM repo_chunk_terms WHERE index_id = ? AND term = ?`
// for each query token. Composite PK avoids duplicate entries and keeps
// per-term lookup O(log n).
export const repoChunkTerms = sqliteTable(
  "repo_chunk_terms",
  {
    indexId: integer("index_id").notNull().references(() => repoIndexes.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    chunkId: integer("chunk_id").notNull().references(() => repoChunks.id, { onDelete: "cascade" }),
    freq: integer("freq").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.indexId, t.term, t.chunkId] }),
    idxTerm: index("idx_repo_chunk_terms_term").on(t.indexId, t.term),
  })
);

// Tombstone log of resurface attempts. Each row records that we asked the LLM
// "does bookmarked repo R fit project P for user U?" — successful or not.
// `outcome` distinguishes 'matched' (a resurface match was inserted) from
// 'no-fit' (LLM said this bookmark doesn't serve any of the project's
// outcomes). The pipeline reads this table to enforce the recurring 20-day
// retry window per (user, repo, project): pairs with a tombstone newer than
// RESURFACE_RETRY_DAYS are skipped. See docs/bookmark-resurface-scope.md.
export const resurfaceAttempts = sqliteTable(
  "resurface_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").notNull().references(() => repos.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull().references(() => projectProfiles.id, { onDelete: "cascade" }),
    attemptedAt: integer("attempted_at", { mode: "timestamp" }).notNull(),
    outcome: text("outcome").notNull(), // 'matched' | 'no-fit'
  },
  (t) => ({
    uniqPair: uniqueIndex("uniq_resurface_attempt_pair").on(t.userId, t.repoId, t.projectId),
    idxUserTime: index("idx_resurface_attempts_user_time").on(t.userId, t.attemptedAt),
  })
);

// Links source handles across platforms to a single creator. E.g.
//   (threads, marc.caz) → "marc-caz"
//   (tiktok,  whitewhoadie) → "marc-caz"
// Used by the dashboard to prefer a higher-priority source (tiktok > threads)
// when the same project surfaces from multiple handles owned by one creator.
export const creatorAliases = sqliteTable(
  "creator_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(), // 'threads' | 'tiktok' | 'reddit' | 'rss' | 'other'
    value: text("value").notNull(),
    creatorKey: text("creator_key").notNull(), // free-form slug picked by admin
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqKindValue: uniqueIndex("uniq_creator_alias_kind_value").on(t.kind, t.value),
    idxCreator: index("idx_creator_alias_creator").on(t.creatorKey),
  })
);

// Forensic log of every at-rest secret decryption. Records who/what/when/why.
// Lets you spot abuse (settings page reading the PAT three times per visit
// when it only needs to mask it, or a single user generating decrypt traffic
// orders of magnitude beyond peers).
export const secretAccessLog = sqliteTable(
  "secret_access_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    column: text("column").notNull(),    // 'githubToken' | 'deepseekApiKey' | 'anthropicApiKey' | 'dekCiphertext'
    reason: text("reason").notNull(),    // 'pipeline-run' | 'mcp-handoff' | 'settings-view' | 'migration' | 'auto-detect' | other
    success: integer("success", { mode: "boolean" }).notNull().default(true),
    errorMessage: text("error_message"),
    accessedAt: integer("accessed_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxUserTime: index("idx_secret_access_user_time").on(t.userId, t.accessedAt),
    idxReasonTime: index("idx_secret_access_reason_time").on(t.reason, t.accessedAt),
  })
);

// Append-only activity log for a pipeline run. Each significant decision
// (fetch start/done, scan, triage skip, match, etc.) is written here so the
// dashboard can render a live, line-by-line progress feed during an
// in-flight run. Reads are cheap (indexed by run_id).
//
// Retention: run_id is NOT a foreign key (it references a digest_runs row but
// carries no FK constraint), so there is no run-cascade purge. Cleanup is two
// paths instead: (1) user_id has ON DELETE CASCADE, so account deletion reaps a
// user's events; (2) prunePipelineEvents() in the nightly cron deletes events
// older than the retention window. Don't rely on a run cascade that doesn't
// exist.
export const pipelineEvents = sqliteTable(
  "pipeline_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    // 'fetch_start' | 'fetch_done' | 'scan' | 'skip' | 'triage_skip'
    // | 'reason' | 'match' | 'error'
    kind: text("kind").notNull(),
    // Pre-formatted display string. The UI doesn't have to know about kinds
    // — it just renders the message verbatim and uses kind for styling.
    message: text("message").notNull(),
  },
  (t) => ({
    idxRunTime: index("idx_pipeline_events_run_time").on(t.runId, t.createdAt),
  })
);

export const digestRuns = sqliteTable(
  "digest_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    candidatesFound: integer("candidates_found").default(0),
    reposAnalyzed: integer("repos_analyzed").default(0),
    matchesCreated: integer("matches_created").default(0),
    emailSent: integer("email_sent", { mode: "boolean" }).default(false),
    errorLog: text("error_log"),
    deepseekInputTokens: integer("deepseek_input_tokens").default(0),
    deepseekOutputTokens: integer("deepseek_output_tokens").default(0),
    anthropicInputTokens: integer("anthropic_input_tokens").default(0),
    anthropicOutputTokens: integer("anthropic_output_tokens").default(0),
    costUsd: real("cost_usd").default(0),
    // If the run was skipped/aborted before reaching analysis, the reason.
    // e.g. 'cost-cap', 'no-candidates', 'no-projects'.
    pausedReason: text("paused_reason"),
  },
  (t) => ({
    idxUserTime: index("idx_digest_runs_user_time").on(t.userId, t.startedAt),
  })
);

// Initiative #3: synthesis across matches. One row per insight produced
// by the synthesizer for a given run. The insight references its
// supporting matches via evidence_match_ids (JSON array) so the feed UI
// can render "Evidence: 4 matches" with a link out to each.
//
// kind dimensions:
//   topic         — N matches share a topic / theme cluster
//   cross-project — same theme hits ≥2 projects via separate matches
//   approach      — N matches share an integrationApproach (e.g. lots
//                   of cleanroom-rebuild candidates this run)
//
// user_status mirrors matches.user_status so the feed can hide / star
// insights independent of the matches that fed them.
export const matchInsights = sqliteTable(
  "match_insights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    runId: integer("run_id").notNull(),
    kind: text("kind").notNull(), // 'topic' | 'cross-project' | 'approach'
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    evidenceMatchIds: text("evidence_match_ids").notNull(), // JSON array of match.id values
    primaryProjectSlug: text("primary_project_slug"),
    themes: text("themes"), // JSON array of shared theme tags
    userStatus: text("user_status").notNull().default("unread"), // 'unread' | 'starred' | 'hidden'
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxUserRun: index("idx_insights_user_run").on(t.userId, t.runId),
    idxUserCreated: index("idx_insights_user_created").on(t.userId, t.createdAt),
  })
);

// Phase 5 — the shared capability catalogue. A CROSS-USER, capability-indexed
// pool of high-quality OSS libraries, sourced by searching GitHub for the
// capabilities that the union of all users' projects actually need. Public-OSS
// metadata only (no user project data) so cross-user sharing is safe.
//
// Why: per-user sourcing means a brand-new project can only match repos its own
// targeted search has fetched yet. The catalogue lets it match the best library
// for each of its capabilities immediately — and it improves with every user
// (a capability one user surfaced is cached for the next). Matching against it
// is the same faceted cosine as the per-user pool, with the same relevance
// floor + competitor suppression, so it doesn't become a trending firehose.
export const catalogueRepos = sqliteTable(
  "catalogue_repos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fullName: text("full_name").notNull(), // "owner/name", unique
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    url: text("url"),
    topics: text("topics"), // JSON string[]
    stars: integer("stars"),
    primaryLanguage: text("primary_language"),
    repoShape: text("repo_shape"), // 'lib' | 'app' | ... (for competitor suppression)
    license: text("license"),
    pushedAt: integer("pushed_at", { mode: "timestamp" }),
    // Repo age — drives the recency/trending boost: a recently-created repo that
    // fills a capability you have is the "rising gem" signal (the thing you'd
    // catch on a creator's feed before it's canonical), so it ranks UP rather
    // than getting buried under the all-time star leader.
    createdAt: integer("created_at", { mode: "timestamp" }),
    embedding: text("embedding"), // serialised vector (matched against project facets)
    // Cleaned first ~1.5k chars of the repo README — embedded alongside
    // title/description/topics. Title+description alone was the retrieval
    // ceiling: ~50 words of text per candidate.
    readmeHead: text("readme_head"),
    capabilities: text("capabilities"), // JSON string[] — capability labels that sourced this repo
    // library | framework | app | experiment | content | unknown (classify.ts).
    // Only library/framework/app are kept; experiment/content (viral hype,
    // curated lists, "skills" repos) are filtered out — viral != adoptable.
    kind: text("kind"),
    // Data modality (JSON Modality[] — src/projects/modality.ts). Drives the
    // cross-modal gate. NULL = unknown → gate stays open.
    modality: text("modality"),
    firstSeen: integer("first_seen", { mode: "timestamp" }).notNull(),
    lastSeen: integer("last_seen", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqFullName: uniqueIndex("uniq_catalogue_full_name").on(t.fullName),
    idxStars: index("idx_catalogue_stars").on(t.stars),
  })
);

// Tracks when each capability label was last searched against GitHub, so the
// builder refreshes stale capabilities round-robin and skips fresh ones —
// bounding GitHub API spend as the catalogue warms across users.
export const catalogueCapabilities = sqliteTable("catalogue_capabilities", {
  label: text("label").primaryKey(), // lowercased capability label
  lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp" }).notNull(),
  repoCount: integer("repo_count").notNull().default(0),
  // Phase 7: the capability label's OWN embedding. Drives capability adjacency —
  // a catalogue capability whose vector is near (but distinct from) one of a
  // project's capabilities is "adjacent", and we surface its best library as an
  // exploratory suggestion ("you don't use graph memory, but it's adjacent to
  // your intel-correlation").
  embedding: text("embedding"),
});

// ============================================================================
// Atlas — the materialized per-user knowledge graph (docs/knowledge-graph-plan.md).
// Derived from facets / triage_events / product_key / catalogue, rebuilt
// deterministically. Nodes + edges power Leaps, recall, the Atlas export, themes.
// ============================================================================

export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    // 'project' | 'product' | 'capability' | 'candidate' | 'modality'
    kind: text("kind").notNull(),
    // Stable key within (userId, kind): project slug, normLabel for capability,
    // owner/name for candidate, product key, modality value.
    nodeKey: text("node_key").notNull(),
    label: text("label").notNull(),
    // Kind-specific JSON (modality, provenance, stars, descriptor, …).
    data: text("data"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqNode: uniqueIndex("uniq_graph_node").on(t.userId, t.kind, t.nodeKey),
    idxUserKind: index("idx_graph_node_user_kind").on(t.userId, t.kind),
  }),
);

export const graphEdges = sqliteTable(
  "graph_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    // HAS_CAPABILITY | ADJACENT_TO | FILLS | EVALUATED | MEMBER_OF | RELATES_TO | ENDORSED_BY_SIMILAR
    kind: text("kind").notNull(),
    srcId: integer("src_id").notNull(), // graph_nodes.id
    dstId: integer("dst_id").notNull(), // graph_nodes.id
    weight: real("weight"),             // cosine / strength
    // Edge-specific JSON (provenance, verdict, reasonCode, score, modality, …).
    data: text("data"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxUserKind: index("idx_graph_edge_user_kind").on(t.userId, t.kind),
    idxSrc: index("idx_graph_edge_src").on(t.userId, t.srcId),
    idxDst: index("idx_graph_edge_dst").on(t.userId, t.dstId),
  }),
);

export const userGraphMeta = sqliteTable("user_graph_meta", {
  userId: integer("user_id").primaryKey(),
  contentHash: text("content_hash"),
  nodeCount: integer("node_count").notNull().default(0),
  edgeCount: integer("edge_count").notNull().default(0),
  builtAt: integer("built_at", { mode: "timestamp" }),
});

// Atlas Carts — a user-saved view over a built-in cart: the base cart it
// derives from + a layout + saved filters. Presentation config only; the data
// is still the graph (graph_nodes/graph_edges). No node text lives here.
export const atlasCarts = sqliteTable(
  "atlas_carts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    // The built-in cart this saved view derives from (blind-spots, triage, …).
    baseCart: text("base_cart").notNull(),
    layout: text("layout"),
    // JSON { provenance?, modality?, verdict?, project?, q? }
    filtersJson: text("filters_json"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqName: uniqueIndex("uniq_atlas_cart_user_name").on(t.userId, t.name),
    idxUser: index("idx_atlas_cart_user").on(t.userId),
  }),
);

// ============================================================================
// Pricing watch — track the pricing pages of ~255 paid developer tools and
// surface "P.s. <vendor> updated their pricing" when a tool a user actually
// uses changes price. Seeded from the curated tracker (vendor/tool/URL);
// snapshots come from the Scrapling-based scraper (scripts/pricing-scrape.py,
// driven by src/pricing/scrape.ts on the cron). No prices are stored at seed
// time — the first successful scrape is the baseline, diffs after that.
// ============================================================================

export const pricingTools = sqliteTable(
  "pricing_tools",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    category: text("category"),
    subCategory: text("sub_category"),
    vendor: text("vendor").notNull(),
    tool: text("tool").notNull(),
    pricingUrl: text("pricing_url").notNull(),
    notes: text("notes"),
    // JSON string[] of normalized tokens used to decide "does this user use
    // this tool" against their deps + tags (e.g. ["supabase"]). Derived at
    // import; generic words (cloud, api, platform…) are excluded.
    detectTokens: text("detect_tokens"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastScrapedAt: integer("last_scraped_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqUrl: uniqueIndex("uniq_pricing_tool_url").on(t.pricingUrl),
    idxDue: index("idx_pricing_tools_due").on(t.active, t.lastScrapedAt),
  }),
);

export const pricingSnapshots = sqliteTable(
  "pricing_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    toolId: integer("tool_id").notNull().references(() => pricingTools.id, { onDelete: "cascade" }),
    capturedAt: integer("captured_at", { mode: "timestamp" }).notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull().default(false),
    // JSON string[] of normalized price points found on the page ("$25/mo").
    amounts: text("amounts"),
    // JSON Record<planName, string[]> — price points anchored to a plan word
    // (pro/team/business/…). The stable subset we diff on for volatile pages.
    plans: text("plans"),
    hash: text("hash"),
    error: text("error"),
  },
  (t) => ({
    idxToolTime: index("idx_pricing_snapshots_tool").on(t.toolId, t.capturedAt),
  }),
);

export const pricingChanges = sqliteTable(
  "pricing_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    toolId: integer("tool_id").notNull().references(() => pricingTools.id, { onDelete: "cascade" }),
    detectedAt: integer("detected_at", { mode: "timestamp" }).notNull(),
    // Human one-liner, built deterministically from the diff:
    // "Pro: $25/mo → $29/mo" or "price points changed".
    summary: text("summary").notNull(),
    // The plan whose price moved, when a single plan accounts for the diff.
    plan: text("plan"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => ({
    idxTime: index("idx_pricing_changes_time").on(t.detectedAt),
  }),
);

// One "P.s." per (user, change), ever — the footnote never repeats itself.
export const pricingSurfaces = sqliteTable(
  "pricing_surfaces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    changeId: integer("change_id").notNull().references(() => pricingChanges.id, { onDelete: "cascade" }),
    surfacedAt: integer("surfaced_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqUserChange: uniqueIndex("uniq_pricing_surface").on(t.userId, t.changeId),
  }),
);

// ============================================================================
// Announcement sources — the curated watch catalogue behind the announcement
// layer (Phase 1 of the developer-announcement tracker). ~1k sources across
// github_releases / pricing_page / security_page / status_page / changelog /
// rss+web, each tagged with its likely event types, priority, and the four
// impact questions (will_break_app / security_issue / bill_increase /
// upgrade_needed). Phase 1 consumes two slices: pricing_page rows merge into
// pricing_tools, and github_releases rows extend the stack-watch vendor
// registry (DB-backed, detect-token matched against user deps + tags).
// Polling for the remaining source types is Phase 2.
// ============================================================================

export const announcementSources = sqliteTable(
  "announcement_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: text("source_id").notNull(), // stable "SRC-0001" key from the seed
    vendor: text("vendor").notNull(),
    product: text("product").notNull(),
    category: text("category"),
    subCategory: text("sub_category"),
    sourceUrl: text("source_url").notNull(),
    // github_releases | github_advisories | pricing_page | security_page |
    // status_page | changelog | rss+web | web | web+api | git_repo | api+web | api_docs
    sourceType: text("source_type").notNull(),
    eventTypes: text("event_types"), // JSON string[] from the 14-type taxonomy
    priority: text("priority").notNull().default("P2"), // P0..P3
    pollFrequency: text("poll_frequency"),
    parserStrategy: text("parser_strategy"),
    ecosystems: text("ecosystems"),
    keywords: text("keywords"),
    // JSON string[] — same matching contract as pricing_tools.detect_tokens.
    detectTokens: text("detect_tokens"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    urlConfidence: text("url_confidence"),
    seedStatus: text("seed_status"),
    // The four product questions this source's events tend to answer.
    willBreakApp: integer("will_break_app", { mode: "boolean" }).notNull().default(false),
    securityIssue: integer("security_issue", { mode: "boolean" }).notNull().default(false),
    billIncrease: integer("bill_increase", { mode: "boolean" }).notNull().default(false),
    upgradeNeeded: integer("upgrade_needed", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
    // Source health (the pack's source_checks concept, lean): consecutive
    // failures auto-retire a dead URL into seed_status='needs_review'.
    lastCheckStatus: text("last_check_status"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqSourceId: uniqueIndex("uniq_announcement_source_id").on(t.sourceId),
    idxTypeActive: index("idx_announcement_sources_type").on(t.sourceType, t.active),
  }),
);

// Last fetched text per HTML announcement source — the diff baseline. Feed
// sources don't need it (items are naturally keyed); HTML changelogs and
// security pages diff line-sets between fetches.
export const announcementPageCache = sqliteTable("announcement_page_cache", {
  sourcePk: integer("source_pk").primaryKey().references(() => announcementSources.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  hash: text("hash").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
});

// One row per distinct announcement item seen at a source (a feed entry, or a
// batch of new lines on an HTML page). Append-only; raw_hash dedupes.
export const rawAnnouncements = sqliteTable(
  "raw_announcements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourcePk: integer("source_pk").notNull().references(() => announcementSources.id, { onDelete: "cascade" }),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
    rawHash: text("raw_hash").notNull(),
  },
  (t) => ({
    uniqRaw: uniqueIndex("uniq_raw_announcement").on(t.sourcePk, t.rawHash),
    idxFetched: index("idx_raw_announcements_fetched").on(t.fetchedAt),
  }),
);

// A raw announcement the keyword classifier judged to be one of the 14 event
// types, with severity and the four impact answers. This is what surfaces.
export const classifiedEvents = sqliteTable(
  "classified_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rawId: integer("raw_id").references(() => rawAnnouncements.id, { onDelete: "cascade" }),
    sourcePk: integer("source_pk").notNull().references(() => announcementSources.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    severity: text("severity").notNull(), // Low | Medium | High | Critical
    title: text("title").notNull(),
    summary: text("summary"),
    url: text("url"),
    willBreakApp: integer("will_break_app", { mode: "boolean" }).notNull().default(false),
    securityIssue: integer("security_issue", { mode: "boolean" }).notNull().default(false),
    billIncrease: integer("bill_increase", { mode: "boolean" }).notNull().default(false),
    upgradeNeeded: integer("upgrade_needed", { mode: "boolean" }).notNull().default(false),
    detectedAt: integer("detected_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxDetected: index("idx_classified_events_detected").on(t.detectedAt),
    idxType: index("idx_classified_events_type").on(t.eventType, t.severity),
  }),
);

// One footnote mention per (user, event), ever — same contract as
// pricing_surfaces.
export const announcementSurfaces = sqliteTable(
  "announcement_surfaces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("event_id").notNull().references(() => classifiedEvents.id, { onDelete: "cascade" }),
    surfacedAt: integer("surfaced_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqUserEvent: uniqueIndex("uniq_announcement_surface").on(t.userId, t.eventId),
  }),
);

// Dated obligations — EOLs and deprecation deadlines. Two feeds: structured
// cycles from endoflife.date (runtimes, databases, frameworks) and dates
// extracted from deprecation/breaking-change announcements. Each row is one
// (product, cycle, deadline); surfacing is staged (announce → T-30 → T-7)
// via deadline_surfaces phases so a deadline reminds without repeating.
export const deadlineEvents = sqliteTable(
  "deadline_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // 'eol:<slug>:<cycle>:<date>' or 'ann:<sourcePk>:<hash>' — idempotency key.
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind").notNull(), // 'eol' | 'deprecation'
    product: text("product").notNull(),
    cycle: text("cycle"),
    title: text("title").notNull(),
    url: text("url"),
    deadline: integer("deadline", { mode: "timestamp" }).notNull(),
    // JSON string[] — same matching contract as the other watch surfaces.
    detectTokens: text("detect_tokens"),
    sourcePk: integer("source_pk").references(() => announcementSources.id, { onDelete: "set null" }),
    detectedAt: integer("detected_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqKey: uniqueIndex("uniq_deadline_key").on(t.dedupeKey),
    idxDeadline: index("idx_deadline_events_deadline").on(t.deadline),
  }),
);

export const deadlineSurfaces = sqliteTable(
  "deadline_surfaces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    deadlineId: integer("deadline_id").notNull().references(() => deadlineEvents.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(), // 'announce' | 't30' | 't7'
    surfacedAt: integer("surfaced_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqUserDeadlinePhase: uniqueIndex("uniq_deadline_surface").on(t.userId, t.deadlineId, t.phase),
  }),
);

// Click-to-queue — the awareness→action bridge. A brief/alert item (or the
// in-session agent) queues a piece of work; the next coding session's
// footnote offers to handle it, and the agent resolves it via replen_queue.
export const queuedActions = sqliteTable(
  "queued_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // What kind of thing was queued: 'deadline' | 'event' | 'pricing' | 'custom'
    kind: text("kind").notNull(),
    refId: integer("ref_id"), // id in the kind's table (null for custom)
    title: text("title").notNull(),
    note: text("note"),
    projectSlug: text("project_slug"),
    status: text("status").notNull().default("queued"), // 'queued' | 'done' | 'dismissed'
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    // Footnote nag throttle: remind at most once a day until resolved.
    lastRemindedAt: integer("last_reminded_at", { mode: "timestamp" }),
  },
  (t) => ({
    idxUserStatus: index("idx_queued_actions_user").on(t.userId, t.status),
  }),
);

// ============================================================================
// Atlas as INPUT — user judgment flowing back into the engine (all written
// from the webapp dossiers via server actions; all consumed by the matcher,
// the watch lenses, recall, and the vault).
// ============================================================================

// Plan/tier per external tool ("we're on Supabase Pro") + migrate-off intent.
export const toolPrefs = sqliteTable(
  "tool_prefs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(), // lowercased tool node key (dep name)
    plan: text("plan"),
    migrateOff: integer("migrate_off", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ uniqUserTool: uniqueIndex("uniq_tool_pref").on(t.userId, t.tool) }),
);

// What the user WANTS to build — aspirational capabilities. Embedded once at
// creation; they act as goal facets in matching (never "covered"), steer the
// scouted searches, and render as goal nodes on the graph.
export const capabilityGoals = sqliteTable(
  "capability_goals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectSlug: text("project_slug"), // null = portfolio-wide
    label: text("label").notNull(),
    descriptor: text("descriptor"),
    status: text("status").notNull().default("active"), // active | done | dropped
    embedding: text("embedding"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (t) => ({ idxUserStatus: index("idx_capability_goals_user").on(t.userId, t.status) }),
);

// Curation rules: rename / merge / delete / confirm on capabilities. Applied
// to stored facets immediately AND re-applied at graph build + inventory read,
// so a regenerated facet can't resurrect a deleted/renamed label.
export const capabilityCurations = sqliteTable(
  "capability_curations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    normLabel: text("norm_label").notNull(),
    action: text("action").notNull(), // delete | rename | merge | confirm
    target: text("target"),           // new label (rename) / target label (merge)
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ uniqUserLabel: uniqueIndex("uniq_capability_curation").on(t.userId, t.normLabel) }),
);

// Anchored notes — institutional memory tied to a graph node, surfaced via
// recall and the vault. Deliberately NOT free-floating memory.
export const nodeNotes = sqliteTable(
  "node_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    nodeKey: text("node_key").notNull(),
    note: text("note").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ uniqUserNode: uniqueIndex("uniq_node_note").on(t.userId, t.kind, t.nodeKey) }),
);

// Always-on delivery logs. One brief per (user, ISO week); one critical
// alert per (user, event) — ever. Same once-only contract as the footnote.
export const briefLog = sqliteTable(
  "brief_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    weekKey: text("week_key").notNull(), // e.g. "2026-W24"
    sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqUserWeek: uniqueIndex("uniq_brief_user_week").on(t.userId, t.weekKey),
  }),
);

export const alertLog = sqliteTable(
  "alert_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("event_id").notNull().references(() => classifiedEvents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // 'email' | 'webhook'
    sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqUserEventChannel: uniqueIndex("uniq_alert_user_event").on(t.userId, t.eventId, t.channel),
  }),
);

// Quiet-day leap budget. One row per leap surfaced in the inventory footnote,
// so the calm cadence holds: at most one leap per project per
// REPLEN_LEAP_QUIET_DAYS, and a leap already shown isn't shown again.
export const leapSurfaces = sqliteTable(
  "leap_surfaces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull().references(() => projectProfiles.id, { onDelete: "cascade" }),
    // kind:capability:candidate — dedup key for "already surfaced this leap"
    leapKey: text("leap_key").notNull(),
    surfacedAt: integer("surfaced_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxUserProject: index("idx_leap_surfaces_user_project").on(t.userId, t.projectId, t.surfacedAt),
  }),
);

// ── KEYSTONE — Replen's comparative-knowledge ontology ───────────────────────
// The type-level map of the software-capability space: capabilities, the
// solutions that fill them (libraries / hosted models / services / algorithms /
// architectural practices), and the typed edges between them — including the
// new `better_than`, the primitive that turns Replen from "does it fit?" into
// "is it better? / would it help?". Peer of Atlas (per-user instances),
// Watchtower (sources), Brainstem (matching). DYNAMIC by design — it's all
// rows, not hardcoded enums ("schema as data, not code"): new capabilities,
// solutions, edge kinds, and ingested client ontologies extend it without a
// redeploy. CROSS-USER / global operational data (like the catalogue), so no
// user_id. Seeded from small committed seeds under seeds/keystone/.
export const keystoneCapabilities = sqliteTable(
  "keystone_capabilities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: text("label").notNull(),
    normLabel: text("norm_label").notNull(),
    domain: text("domain"),                 // coarse grouping (e.g. "retrieval", "vision", "data-architecture")
    parentId: integer("parent_id"),         // is-a hierarchy (self-ref; "semantic segmentation" is-a "computer vision")
    modality: text("modality"),             // JSON string[] — the data shapes this capability operates on
    embedding: text("embedding"),           // JSON number[] — for matching a user facet to a Keystone capability
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (t) => ({ uniqNorm: uniqueIndex("uniq_keystone_capability").on(t.normLabel) }),
);

// A solution that fills capabilities — kind-typed so libraries, hosted models,
// services, algorithms, and practices are ALL first-class from day one (adding
// a category is rows, never a schema change).
export const keystoneSolutions = sqliteTable(
  "keystone_solutions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),           // library | hosted_model | service | algorithm | practice
    name: text("name").notNull(),
    normName: text("norm_name").notNull(),
    source: text("source"),                 // github | hosted | concept | ingested
    description: text("description"),
    attributes: text("attributes"),         // JSON — benchmarks {mteb:...}, cost, license, repo, etc.
    embedding: text("embedding"),           // JSON number[]
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (t) => ({ uniqKindName: uniqueIndex("uniq_keystone_solution").on(t.kind, t.normName) }),
);

// Typed directed edges between Keystone nodes. The edge KIND carries the
// semantics; `attributes` carries the evidence (a better_than edge records
// {task, metric, margin, source} so a suggestion can cite WHY).
export const keystoneEdges = sqliteTable(
  "keystone_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromKind: text("from_kind").notNull(),  // capability | solution
    fromId: integer("from_id").notNull(),
    toKind: text("to_kind").notNull(),      // capability | solution
    toId: integer("to_id").notNull(),
    kind: text("kind").notNull(),           // is_a | fills | adjacent_to | better_than | paired_with
    weight: real("weight"),
    attributes: text("attributes"),         // JSON — e.g. {task, metric, margin, source} for better_than
    source: text("source"),                 // seed | benchmark | derived | ingested  (provenance)
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    idxFrom: index("idx_keystone_edges_from").on(t.fromKind, t.fromId, t.kind),
    idxTo: index("idx_keystone_edges_to").on(t.toKind, t.toId, t.kind),
  }),
);

// Calm-cadence dedup for Keystone upgrade footnotes — at most one upgrade line
// per (user, project, upgrade) ever, so "you're on a deprecated dep" is said
// once, not every session. The upgrade still rides in the inventory DATA block
// for the agent regardless; this only gates the one-line footnote surface.
export const keystoneSurfaces = sqliteTable(
  "keystone_surfaces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull().references(() => projectProfiles.id, { onDelete: "cascade" }),
    upgradeKey: text("upgrade_key").notNull(), // `${current}->${better}` — dedup key
    surfacedAt: integer("surfaced_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ uniqUserProjectUpgrade: uniqueIndex("uniq_keystone_surface").on(t.userId, t.projectId, t.upgradeKey) }),
);

// Per-candidate FEATURE LOG at match time (#5). Every candidate surfaced by
// replen_match writes one row with the features that fed its rank. Joined to
// triage_events later (by full_name + user/project) it yields (features →
// verdict) training rows — the prerequisite for a true full-rank eval replay AND
// for training the learned ranker (workstream A). Append-only; no user code.
export const matchFeatures = sqliteTable(
  "match_features",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: integer("project_id").references(() => projectProfiles.id, { onDelete: "set null" }),
    fullName: text("full_name").notNull(),       // candidate owner/name, lowercased — join key to repos/triage
    surfacedAt: integer("surfaced_at", { mode: "timestamp" }).notNull(),
    // features that fed the rank (the learned ranker's inputs)
    cosine: real("cosine"),
    matchedFacet: text("matched_facet"),
    facetModality: text("facet_modality"),
    matchedProvenance: text("matched_provenance"),
    source: text("source"),
    repoShape: text("repo_shape"),
    stars: integer("stars"),
    language: text("language"),
    depMatch: integer("dep_match", { mode: "boolean" }).notNull().default(false),
    covered: integer("covered", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull(),     // 0 = top of candidatesOut
    headlined: integer("headlined", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({ byUserName: index("idx_match_features_user_name").on(t.userId, t.fullName) }),
);
