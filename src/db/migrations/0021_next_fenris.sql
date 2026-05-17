CREATE TABLE `pipeline_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_run_time` ON `pipeline_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_digest_runs_user_time` ON `digest_runs` (`user_id`,`started_at`);