ALTER TABLE `matches` ADD `handoff_pr_status` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `handoff_pr_checked_at` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `integrated_at` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `personal_note` text;--> statement-breakpoint
ALTER TABLE `users` ADD `last_viewed_at` integer;