-- Announcement layer phase 2: page-diff cache, raw announcements, classified
-- events (event type + severity + the four impact answers), per-user surfacing
-- log, and source-health columns.
ALTER TABLE `announcement_sources` ADD COLUMN `last_check_status` text;
--> statement-breakpoint
ALTER TABLE `announcement_sources` ADD COLUMN `consecutive_failures` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `announcement_page_cache` (
  `source_pk` integer PRIMARY KEY NOT NULL REFERENCES `announcement_sources`(`id`) ON DELETE CASCADE,
  `text` text NOT NULL,
  `hash` text NOT NULL,
  `fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_announcements` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source_pk` integer NOT NULL REFERENCES `announcement_sources`(`id`) ON DELETE CASCADE,
  `canonical_url` text NOT NULL,
  `title` text NOT NULL,
  `summary` text,
  `published_at` integer,
  `fetched_at` integer NOT NULL,
  `raw_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_raw_announcement` ON `raw_announcements` (`source_pk`,`raw_hash`);
--> statement-breakpoint
CREATE INDEX `idx_raw_announcements_fetched` ON `raw_announcements` (`fetched_at`);
--> statement-breakpoint
CREATE TABLE `classified_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `raw_id` integer REFERENCES `raw_announcements`(`id`) ON DELETE CASCADE,
  `source_pk` integer NOT NULL REFERENCES `announcement_sources`(`id`) ON DELETE CASCADE,
  `event_type` text NOT NULL,
  `severity` text NOT NULL,
  `title` text NOT NULL,
  `summary` text,
  `url` text,
  `will_break_app` integer NOT NULL DEFAULT 0,
  `security_issue` integer NOT NULL DEFAULT 0,
  `bill_increase` integer NOT NULL DEFAULT 0,
  `upgrade_needed` integer NOT NULL DEFAULT 0,
  `detected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_classified_events_detected` ON `classified_events` (`detected_at`);
--> statement-breakpoint
CREATE INDEX `idx_classified_events_type` ON `classified_events` (`event_type`,`severity`);
--> statement-breakpoint
CREATE TABLE `announcement_surfaces` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `event_id` integer NOT NULL REFERENCES `classified_events`(`id`) ON DELETE CASCADE,
  `surfaced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_announcement_surface` ON `announcement_surfaces` (`user_id`,`event_id`);
