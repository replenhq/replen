-- Announcement sources: the curated ~1k-source watch catalogue (releases,
-- advisories, pricing pages, security pages, status pages, changelogs), each
-- tagged with event types, priority, and the four impact questions.
CREATE TABLE `announcement_sources` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source_id` text NOT NULL,
  `vendor` text NOT NULL,
  `product` text NOT NULL,
  `category` text,
  `sub_category` text,
  `source_url` text NOT NULL,
  `source_type` text NOT NULL,
  `event_types` text,
  `priority` text NOT NULL DEFAULT 'P2',
  `poll_frequency` text,
  `parser_strategy` text,
  `ecosystems` text,
  `keywords` text,
  `detect_tokens` text,
  `active` integer NOT NULL DEFAULT 1,
  `url_confidence` text,
  `seed_status` text,
  `will_break_app` integer NOT NULL DEFAULT 0,
  `security_issue` integer NOT NULL DEFAULT 0,
  `bill_increase` integer NOT NULL DEFAULT 0,
  `upgrade_needed` integer NOT NULL DEFAULT 0,
  `notes` text,
  `last_checked_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_announcement_source_id` ON `announcement_sources` (`source_id`);
--> statement-breakpoint
CREATE INDEX `idx_announcement_sources_type` ON `announcement_sources` (`source_type`,`active`);
