ALTER TABLE `user_settings` ADD `ingest_token_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_settings_ingest_hash` ON `user_settings` (`ingest_token_hash`);