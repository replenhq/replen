ALTER TABLE `user_settings` ADD `digest_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `security_alerts_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `brief_frequency` text DEFAULT 'weekly' NOT NULL;
