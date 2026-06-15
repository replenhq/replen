CREATE TABLE `triage_insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`via_candidate_repo_id` integer,
	`applies_to_project_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`via_candidate_repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`applies_to_project_id`) REFERENCES `project_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_triage_insights_user_created` ON `triage_insights` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_triage_insights_user_kind` ON `triage_insights` (`user_id`,`kind`);
