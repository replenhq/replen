-- Announcement layer phase 3: dated obligations (EOLs + deprecation
-- deadlines) with staged per-user surfacing (announce / T-30 / T-7).
CREATE TABLE `deadline_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `dedupe_key` text NOT NULL,
  `kind` text NOT NULL,
  `product` text NOT NULL,
  `cycle` text,
  `title` text NOT NULL,
  `url` text,
  `deadline` integer NOT NULL,
  `detect_tokens` text,
  `source_pk` integer REFERENCES `announcement_sources`(`id`) ON DELETE SET NULL,
  `detected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_deadline_key` ON `deadline_events` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `idx_deadline_events_deadline` ON `deadline_events` (`deadline`);
--> statement-breakpoint
CREATE TABLE `deadline_surfaces` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `deadline_id` integer NOT NULL REFERENCES `deadline_events`(`id`) ON DELETE CASCADE,
  `phase` text NOT NULL,
  `surfaced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_deadline_surface` ON `deadline_surfaces` (`user_id`,`deadline_id`,`phase`);
