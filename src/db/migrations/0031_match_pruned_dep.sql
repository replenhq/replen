ALTER TABLE `matches` ADD COLUMN `pruned_dep_name` text;--> statement-breakpoint
ALTER TABLE `matches` ADD COLUMN `pruned_dep_ecosystem` text;--> statement-breakpoint
ALTER TABLE `matches` ADD COLUMN `pruned_dep_action` text;--> statement-breakpoint
ALTER TABLE `matches` ADD COLUMN `pruned_dep_version` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `dep_health_json` text;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD COLUMN `dep_health_generated_at` integer;
