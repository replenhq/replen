ALTER TABLE `project_profiles` ADD `local_path` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD `immersion_tier` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `immersion_tier` text DEFAULT 'off' NOT NULL;
