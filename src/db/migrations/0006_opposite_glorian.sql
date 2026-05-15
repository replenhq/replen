ALTER TABLE `digest_runs` ADD `deepseek_input_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `deepseek_output_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `anthropic_input_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `anthropic_output_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `cost_usd` real DEFAULT 0;