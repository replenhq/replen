ALTER TABLE `digest_runs` ADD `paused_reason` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `daily_cost_cap_usd` real DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `webhook_url` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `webhook_kind` text DEFAULT 'generic' NOT NULL;