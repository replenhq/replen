ALTER TABLE `matches` ADD `handoff_pr_url` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `handoff_created_at` integer;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD `github_full_name` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `github_write_token` text;