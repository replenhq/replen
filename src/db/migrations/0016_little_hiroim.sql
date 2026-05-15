CREATE TABLE `secret_access_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`column` text NOT NULL,
	`reason` text NOT NULL,
	`success` integer DEFAULT true NOT NULL,
	`error_message` text,
	`accessed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_secret_access_user_time` ON `secret_access_log` (`user_id`,`accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_secret_access_reason_time` ON `secret_access_log` (`reason`,`accessed_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `dek_ciphertext` text;