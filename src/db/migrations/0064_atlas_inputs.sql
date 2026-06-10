-- Atlas as INPUT: user judgment flowing back into the engine.
--   tool_prefs           — plan/tier per tool (personal pricing) + migrate-off
--   capability_goals     — what the user WANTS to build (aspirational facets)
--   capability_curations — rename / merge / delete / confirm rules that
--                          survive facet regeneration
--   node_notes           — anchored notes that flow into recall + the vault
CREATE TABLE `tool_prefs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `tool` text NOT NULL,
  `plan` text,
  `migrate_off` integer NOT NULL DEFAULT 0,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tool_pref` ON `tool_prefs` (`user_id`,`tool`);
--> statement-breakpoint
CREATE TABLE `capability_goals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `project_slug` text,
  `label` text NOT NULL,
  `descriptor` text,
  `status` text NOT NULL DEFAULT 'active',
  `embedding` text,
  `created_at` integer NOT NULL,
  `resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_capability_goals_user` ON `capability_goals` (`user_id`,`status`);
--> statement-breakpoint
CREATE TABLE `capability_curations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `norm_label` text NOT NULL,
  `action` text NOT NULL,
  `target` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_capability_curation` ON `capability_curations` (`user_id`,`norm_label`);
--> statement-breakpoint
CREATE TABLE `node_notes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `node_key` text NOT NULL,
  `note` text NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_node_note` ON `node_notes` (`user_id`,`kind`,`node_key`);
