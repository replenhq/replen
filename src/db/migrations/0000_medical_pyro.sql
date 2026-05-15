CREATE TABLE `candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_item_id` text NOT NULL,
	`title` text,
	`url` text NOT NULL,
	`github_url` text,
	`author` text,
	`score` integer,
	`posted_at` integer,
	`fetched_at` integer NOT NULL,
	`raw_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_source_item` ON `candidates` (`source`,`source_item_id`);--> statement-breakpoint
CREATE INDEX `idx_candidates_github` ON `candidates` (`github_url`);--> statement-breakpoint
CREATE TABLE `digest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`candidates_found` integer DEFAULT 0,
	`repos_analyzed` integer DEFAULT 0,
	`matches_created` integer DEFAULT 0,
	`email_sent` integer DEFAULT false,
	`error_log` text
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`project_id` integer,
	`run_id` integer NOT NULL,
	`relevance` text NOT NULL,
	`relevance_score` integer,
	`summary` text,
	`why_useful` text,
	`suggested_use` text,
	`integration_approach` text,
	`risks` text,
	`writeup_md` text,
	`user_status` text DEFAULT 'unread' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_match_repo_project` ON `matches` (`repo_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_match_run` ON `matches` (`run_id`);--> statement-breakpoint
CREATE TABLE `project_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`readme_md` text,
	`claude_md` text,
	`tech_summary` text,
	`profile_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_profile_slug` ON `project_profiles` (`slug`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`description` text,
	`stars` integer,
	`forks` integer,
	`license` text,
	`primary_language` text,
	`pushed_at` integer,
	`created_at` integer,
	`default_branch` text,
	`readme_md` text,
	`readme_sha` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repo` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `safety_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`scanned_at` integer NOT NULL,
	`postinstall_hooks` text,
	`suspicious_patterns` text,
	`age_days` integer,
	`days_since_push` integer,
	`contributor_count` integer,
	`star_velocity` real,
	`secrets_found` integer DEFAULT false,
	`risk_level` text,
	`notes` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
