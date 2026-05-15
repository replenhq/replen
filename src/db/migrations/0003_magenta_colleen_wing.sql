CREATE TABLE `curated_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`label` text,
	`added_by_user_id` integer,
	`proposal_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`added_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_curated_kind_value` ON `curated_sources` (`kind`,`value`);