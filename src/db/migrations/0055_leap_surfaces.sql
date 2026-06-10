-- Quiet-day leap budget: which leaps the inventory footnote has surfaced, per
-- (user, project), so calm cadence holds (≤1 leap / project / window, no repeats).
CREATE TABLE `leap_surfaces` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `project_id` integer NOT NULL REFERENCES `project_profiles`(`id`) ON DELETE CASCADE,
  `leap_key` text NOT NULL,
  `surfaced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_leap_surfaces_user_project` ON `leap_surfaces` (`user_id`,`project_id`,`surfaced_at`);
