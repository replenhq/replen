-- Click-to-queue: awareness→action bridge. Brief/alert items (or the agent)
-- queue work; the next session's footnote offers to handle it.
CREATE TABLE `queued_actions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `ref_id` integer,
  `title` text NOT NULL,
  `note` text,
  `project_slug` text,
  `status` text NOT NULL DEFAULT 'queued',
  `created_at` integer NOT NULL,
  `resolved_at` integer,
  `last_reminded_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_queued_actions_user` ON `queued_actions` (`user_id`,`status`);
