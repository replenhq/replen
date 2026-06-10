-- Always-on layer: weekly four-questions brief + instant critical alerts.
ALTER TABLE `user_settings` ADD COLUMN `weekly_brief_enabled` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE `brief_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `week_key` text NOT NULL,
  `sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_brief_user_week` ON `brief_log` (`user_id`,`week_key`);
--> statement-breakpoint
CREATE TABLE `alert_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `event_id` integer NOT NULL REFERENCES `classified_events`(`id`) ON DELETE CASCADE,
  `channel` text NOT NULL,
  `sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_alert_user_event` ON `alert_log` (`user_id`,`event_id`,`channel`);
