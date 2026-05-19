ALTER TABLE `project_profiles` ADD COLUMN `activity_json` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `activity_generated_at` integer;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `activity_head_sha` text;
