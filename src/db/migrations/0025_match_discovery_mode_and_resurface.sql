ALTER TABLE `matches` ADD COLUMN `discovery_mode` text;--> statement-breakpoint
UPDATE `matches` SET `discovery_mode` = CASE WHEN `matched_outcome` IS NOT NULL THEN 'targeted' ELSE 'serendipity' END;--> statement-breakpoint
ALTER TABLE `matches` ADD COLUMN `resurfaced_from_match_id` integer REFERENCES `matches`(`id`);--> statement-breakpoint
-- Backend separation: an existing 'starred' match on a general-awareness row
-- semantically meant "bookmark for later", not "action item". Backfill those
-- into a distinct user_status value so /starred and the resurface logic can
-- key on intent rather than relevance + status. New stars on general-awareness
-- matches go straight to 'bookmarked' (see src/app/actions.ts).
UPDATE `matches` SET `user_status` = 'bookmarked' WHERE `user_status` = 'starred' AND `relevance` = 'general-awareness';--> statement-breakpoint
CREATE TABLE `resurface_attempts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL,
  `repo_id` integer NOT NULL,
  `project_id` integer NOT NULL,
  `attempted_at` integer NOT NULL,
  `outcome` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`) REFERENCES `project_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_resurface_attempt_pair` ON `resurface_attempts` (`user_id`,`repo_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_resurface_attempts_user_time` ON `resurface_attempts` (`user_id`,`attempted_at`);
