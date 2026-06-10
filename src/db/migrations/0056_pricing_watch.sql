-- Pricing watch: curated tool list + scraped pricing-page snapshots + detected
-- changes + per-user surfacing log ("P.s. <vendor> updated their pricing").
CREATE TABLE `pricing_tools` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `category` text,
  `sub_category` text,
  `vendor` text NOT NULL,
  `tool` text NOT NULL,
  `pricing_url` text NOT NULL,
  `notes` text,
  `detect_tokens` text,
  `active` integer NOT NULL DEFAULT 1,
  `last_scraped_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pricing_tool_url` ON `pricing_tools` (`pricing_url`);
--> statement-breakpoint
CREATE INDEX `idx_pricing_tools_due` ON `pricing_tools` (`active`,`last_scraped_at`);
--> statement-breakpoint
CREATE TABLE `pricing_snapshots` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `tool_id` integer NOT NULL REFERENCES `pricing_tools`(`id`) ON DELETE CASCADE,
  `captured_at` integer NOT NULL,
  `ok` integer NOT NULL DEFAULT 0,
  `amounts` text,
  `plans` text,
  `hash` text,
  `error` text
);
--> statement-breakpoint
CREATE INDEX `idx_pricing_snapshots_tool` ON `pricing_snapshots` (`tool_id`,`captured_at`);
--> statement-breakpoint
CREATE TABLE `pricing_changes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `tool_id` integer NOT NULL REFERENCES `pricing_tools`(`id`) ON DELETE CASCADE,
  `detected_at` integer NOT NULL,
  `summary` text NOT NULL,
  `plan` text,
  `before_json` text,
  `after_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_pricing_changes_time` ON `pricing_changes` (`detected_at`);
--> statement-breakpoint
CREATE TABLE `pricing_surfaces` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `change_id` integer NOT NULL REFERENCES `pricing_changes`(`id`) ON DELETE CASCADE,
  `surfaced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pricing_surface` ON `pricing_surfaces` (`user_id`,`change_id`);
