CREATE TABLE `proposed_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by_user_id` integer,
	`reviewed_at` integer,
	`admin_note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_proposal_status` ON `proposed_sources` (`status`);--> statement-breakpoint
CREATE INDEX `idx_proposal_user` ON `proposed_sources` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`github_token` text,
	`deepseek_api_key` text,
	`anthropic_api_key` text,
	`threads_handles` text,
	`reddit_subs` text,
	`email_to_address` text,
	`enabled` integer DEFAULT true NOT NULL,
	`cron_hour_utc` integer DEFAULT 6 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_settings_user` ON `user_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`firebase_uid` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_user_firebase_uid` ON `users` (`firebase_uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_user_email` ON `users` (`email`);--> statement-breakpoint
DROP INDEX `uniq_source_item`;--> statement-breakpoint
ALTER TABLE `candidates` ADD `user_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_source_item_user` ON `candidates` (`user_id`,`source`,`source_item_id`);--> statement-breakpoint
CREATE INDEX `idx_candidates_user` ON `candidates` (`user_id`);--> statement-breakpoint
DROP INDEX `uniq_profile_slug`;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD `user_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_profile_user_slug` ON `project_profiles` (`user_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_profile_user` ON `project_profiles` (`user_id`);--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `user_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `matches` ADD `user_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_match_user` ON `matches` (`user_id`);