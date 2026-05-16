import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─────────────────────────────────────────────────────────────
// Phase 2: users + per-user settings
// ─────────────────────────────────────────────────────────────

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
    // only the sha256 hash is stored for lookup. The plaintext column below
    // is retained as nullable during the backfill window (drops in a later
    // migration) - any value present is migrated on db boot.
    ingestToken: text("ingest_token"),
    ingestTokenHash: text("ingest_token_hash"),
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
    risks: text("risks"),
    writeupMd: text("writeup_md"),
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
  },
  (t) => ({
    idxRepoProject: index("idx_match_repo_project").on(t.repoId, t.projectId),
    idxRun: index("idx_match_run").on(t.runId),
    idxUser: index("idx_match_user").on(t.userId),
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

export const digestRuns = sqliteTable("digest_runs", {
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
});
