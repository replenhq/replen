-- Lifecycle for MCP ingest tokens (audit H1).
--
-- Today: one token per user, never expires, no record of when it was last
-- used. A leaked token works forever and there's no signal on /settings
-- to surface stale or compromised credentials.
--
-- After: every issued token carries an expiry (90d default — set by the
-- /cli-auth issue path) and the auth middleware stamps last-used on
-- every successful redemption. /settings can then render "Token last
-- used N hours ago, expires in M days" with a revoke + reissue button.
ALTER TABLE `user_settings` ADD COLUMN `ingest_token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `user_settings` ADD COLUMN `ingest_token_last_used_at` integer;
