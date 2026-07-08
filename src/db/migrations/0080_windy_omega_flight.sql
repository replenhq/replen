CREATE TABLE `ranker_weights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`feature_names` text NOT NULL,
	`weights` text NOT NULL,
	`standardization` text NOT NULL,
	`auc` real,
	`n_pos` integer,
	`n_neg` integer,
	`trained_at` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ranker_weights_user_active` ON `ranker_weights` (`user_id`,`active`);