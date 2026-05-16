ALTER TABLE `user_settings` ADD `llm_primary_api_key` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `llm_primary_base_url` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `llm_primary_model` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `llm_sensitive_api_key` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `llm_sensitive_base_url` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `llm_sensitive_model` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `llm_sensitive_wire_format` text;