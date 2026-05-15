CREATE TABLE `creator_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`creator_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_creator_alias_kind_value` ON `creator_aliases` (`kind`,`value`);--> statement-breakpoint
CREATE INDEX `idx_creator_alias_creator` ON `creator_aliases` (`creator_key`);