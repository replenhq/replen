import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

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
  },
  (t) => ({
    uniqSourceItem: uniqueIndex("uniq_source_item_user").on(t.userId, t.source, t.sourceItemId),
    idxGithub: index("idx_candidates_github").on(t.githubUrl),
    idxUser: index("idx_candidates_user").on(t.userId),
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
    uniqRepo: uniqueIndex("uniq_repo").on(t.owner, t.name),
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
    name: text("name").notNull(),
    readmeMd: text("readme_md"),
    claudeMd: text("claude_md"),
    techSummary: text("tech_summary"),
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
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uniqSlug: uniqueIndex("uniq_profile_user_slug").on(t.userId, t.slug),
    idxUser: index("idx_profile_user").on(t.userId),
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
// in-flight run. Reads are cheap (indexed by run_id) and the table is
// purged with the run itself via FK cascade.
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
