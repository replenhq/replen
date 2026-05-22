-- Skill-mode pivot: data model for the new architecture where matching
-- runs in the user's CLI agent (subscription tokens) and Replen reduces
-- to candidate inventory + per-user state.
--
-- Adds:
--   - user_settings.filter_mode: which pre-filter the inventory endpoint
--     applies. 'zero-knowledge' = full firehose, 'tags' = user-curated
--     project tag intersection (default), 'fingerprint' = LSH-style
--     similarity on a project shape hash (opt-in). See FORK.md.
--   - user_settings.subscription_tier: 'skill' (in-CLI, subscription
--     tokens, default) vs 'hosted' (legacy hosted-pipeline tier, BYO API
--     keys, for non-CLI users). Determines which code path runs for a
--     given user on a pipeline cycle.
--   - project_profiles.tags: JSON array of user-curated tags for filter
--     mode 'tags'. Auto-suggested from the project shape; user-editable
--     in /settings.
--   - project_profiles.fingerprint_hash: opaque hash of the project
--     shape used by filter mode 'fingerprint'. Computed locally by the
--     CLI and pushed once; Replen stores the hash, never the source.
--
-- New table:
--   - user_match_state: per-(user, repo) lifecycle state for the skill
--     tier. Replaces what the legacy `matches` table tracks for hosted-
--     tier users. Skill-tier writeups never persist server-side
--     (privacy property: the agent's output stays on the user's box),
--     so we only track outcomes: surfaced / starred / hidden /
--     handed_off. Per (user, repo, project) for context — the same
--     repo can be surfaced in two project contexts and carry
--     independent state.
ALTER TABLE `user_settings` ADD `filter_mode` text NOT NULL DEFAULT 'tags';--> statement-breakpoint
ALTER TABLE `user_settings` ADD `subscription_tier` text NOT NULL DEFAULT 'skill';--> statement-breakpoint
ALTER TABLE `project_profiles` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD `fingerprint_hash` text;--> statement-breakpoint
CREATE TABLE `user_match_state` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `repo_id` integer NOT NULL REFERENCES `repos`(`id`) ON DELETE CASCADE,
  `project_id` integer REFERENCES `project_profiles`(`id`) ON DELETE SET NULL,
  `status` text NOT NULL,
  `surfaced_at` integer NOT NULL,
  `action_at` integer,
  `handoff_pr_url` text,
  `user_note` text
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_user_match_state_repo_project` ON `user_match_state`(`user_id`, `repo_id`, `project_id`);--> statement-breakpoint
CREATE INDEX `idx_user_match_state_user_status` ON `user_match_state`(`user_id`, `status`);--> statement-breakpoint
CREATE INDEX `idx_user_match_state_surfaced` ON `user_match_state`(`user_id`, `surfaced_at`);
