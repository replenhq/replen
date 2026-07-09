CREATE TABLE `admin_passkeys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_passkeys_credential_id_unique` ON `admin_passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `idx_admin_passkeys_user` ON `admin_passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `admin_totp` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
