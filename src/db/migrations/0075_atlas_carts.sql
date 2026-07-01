CREATE TABLE `atlas_carts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`base_cart` text NOT NULL,
	`layout` text,
	`filters_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_atlas_cart_user_name` ON `atlas_carts` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_atlas_cart_user` ON `atlas_carts` (`user_id`);
