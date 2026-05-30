-- L4: cross-user learning loop. Global per-repo quality aggregate built from
-- triage_events across ALL users (each user counted once by their latest
-- verdict). Powers (a) global demote — suppress repos many distinct users
-- judged rubbish, and (b) similar-project promote — surface a repo that
-- earned positive verdicts to a different user whose project is
-- embedding-similar. Recomputed on each triage write (src/lib/repo-quality.ts)
-- and backfillable from existing events (src/cli/backfill-repo-quality.ts).
CREATE TABLE `repo_quality` (
  `repo_id` integer PRIMARY KEY NOT NULL,
  `adopt_users` integer DEFAULT 0 NOT NULL,
  `port_users` integer DEFAULT 0 NOT NULL,
  `skip_users` integer DEFAULT 0 NOT NULL,
  `defer_users` integer DEFAULT 0 NOT NULL,
  `total_users` integer DEFAULT 0 NOT NULL,
  `avg_score` real,
  `last_triaged_at` integer,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_repo_quality_skip` ON `repo_quality` (`skip_users`,`total_users`);
--> statement-breakpoint
CREATE INDEX `idx_repo_quality_positive` ON `repo_quality` (`adopt_users`,`port_users`);
