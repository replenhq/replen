CREATE TABLE `admin_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` integer NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` integer,
	`target_label` text,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_admin_audit_time` ON `admin_audit` (`created_at`);