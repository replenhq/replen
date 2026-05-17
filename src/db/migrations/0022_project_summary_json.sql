ALTER TABLE `project_profiles` ADD COLUMN `summary_json` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `summary_hash` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `summary_generated_at` integer;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `summary_prompt_version` text;
