-- Phase 5 — shared capability catalogue. A cross-user, capability-indexed pool
-- of high-quality OSS libraries (public metadata only), so a project can match
-- the best library for each of its capabilities immediately instead of waiting
-- for its own targeted search to fetch it.
CREATE TABLE `catalogue_repos` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `full_name` text NOT NULL,
  `owner` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `url` text,
  `topics` text,
  `stars` integer,
  `primary_language` text,
  `repo_shape` text,
  `license` text,
  `pushed_at` integer,
  `embedding` text,
  `capabilities` text,
  `first_seen` integer NOT NULL,
  `last_seen` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalogue_full_name` ON `catalogue_repos` (`full_name`);
--> statement-breakpoint
CREATE INDEX `idx_catalogue_stars` ON `catalogue_repos` (`stars`);
--> statement-breakpoint
CREATE TABLE `catalogue_capabilities` (
  `label` text PRIMARY KEY NOT NULL,
  `last_refreshed_at` integer NOT NULL,
  `repo_count` integer DEFAULT 0 NOT NULL
);
