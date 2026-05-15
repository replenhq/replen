ALTER TABLE `project_profiles` ADD `included` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `project_profiles` ADD `sensitivity` text DEFAULT 'low' NOT NULL;