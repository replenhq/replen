-- Append-only log of agent-side triage decisions. Posted by the
-- /replen-match skill via the replen_record_triage MCP tool after
-- each per-candidate verdict. Powers the Activity feed on /, where
-- agent decisions interleave with user actions (user_match_state) on
-- a single timeline.
--
-- Why a separate table from user_match_state:
--   - user_match_state is unique on (user, repo, project) — the
--     user's monotonic state. triage_events allows multiple rows so
--     the agent can re-evaluate the same candidate across sessions.
--   - Different actors. The user stars / hides / hands off; the
--     agent decides adopt / port / skip / defer. They can disagree
--     (agent said skip, user starred anyway). Both are useful
--     signal.
--   - The Activity feed merges both streams ordered by timestamp.
CREATE TABLE `triage_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `repo_id` integer NOT NULL REFERENCES `repos`(`id`) ON DELETE CASCADE,
  `project_id` integer REFERENCES `project_profiles`(`id`) ON DELETE SET NULL,
  `verdict` text NOT NULL,
  `score` integer,
  `effort_band` text,
  `one_line` text,
  `writeup` text,
  `session_id` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_triage_events_user_created` ON `triage_events`(`user_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `idx_triage_events_user_repo` ON `triage_events`(`user_id`, `repo_id`);--> statement-breakpoint
CREATE INDEX `idx_triage_events_session` ON `triage_events`(`user_id`, `session_id`);
