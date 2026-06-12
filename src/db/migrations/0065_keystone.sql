CREATE TABLE `keystone_capabilities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`norm_label` text NOT NULL,
	`domain` text,
	`parent_id` integer,
	`modality` text,
	`embedding` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_keystone_capability` ON `keystone_capabilities` (`norm_label`);--> statement-breakpoint
CREATE TABLE `keystone_solutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`norm_name` text NOT NULL,
	`source` text,
	`description` text,
	`attributes` text,
	`embedding` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_keystone_solution` ON `keystone_solutions` (`kind`,`norm_name`);--> statement-breakpoint
CREATE TABLE `keystone_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` integer NOT NULL,
	`to_kind` text NOT NULL,
	`to_id` integer NOT NULL,
	`kind` text NOT NULL,
	`weight` real,
	`attributes` text,
	`source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_keystone_edges_from` ON `keystone_edges` (`from_kind`,`from_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_keystone_edges_to` ON `keystone_edges` (`to_kind`,`to_id`,`kind`);
