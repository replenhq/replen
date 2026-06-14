CREATE TABLE `match_features` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer,
	`full_name` text NOT NULL,
	`surfaced_at` integer NOT NULL,
	`cosine` real,
	`matched_facet` text,
	`facet_modality` text,
	`matched_provenance` text,
	`source` text,
	`repo_shape` text,
	`stars` integer,
	`language` text,
	`dep_match` integer DEFAULT false NOT NULL,
	`covered` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`headlined` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_match_features_user_name` ON `match_features` (`user_id`,`full_name`);
