ALTER TABLE `project_profiles` ADD COLUMN `search_vectors_json` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `search_vectors_summary_hash` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `search_vectors_generated_at` integer;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `search_vectors_prompt_version` text;
