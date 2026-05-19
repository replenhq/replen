CREATE TABLE `match_insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`run_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`evidence_match_ids` text NOT NULL,
	`primary_project_slug` text,
	`themes` text,
	`user_status` text DEFAULT 'unread' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_insights_user_run` ON `match_insights` (`user_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_insights_user_created` ON `match_insights` (`user_id`,`created_at`);
