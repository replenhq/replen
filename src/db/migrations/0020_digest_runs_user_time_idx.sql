CREATE INDEX IF NOT EXISTS `idx_digest_runs_user_time` ON `digest_runs` (`user_id`, `started_at`);
