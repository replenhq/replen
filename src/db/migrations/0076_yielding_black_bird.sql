CREATE INDEX `idx_candidates_user_fetched` ON `candidates` (`user_id`,`fetched_at`);--> statement-breakpoint
-- Dedupe any pre-existing duplicate global rows before the unique index, or its
-- creation would fail. Per (user_id, repo_id) group with project_id IS NULL,
-- keep the most meaningful row: one that carries a user action (starred/hidden/
-- handed_off) over a bare surfacing, then the most recent, then the highest id.
DELETE FROM `user_match_state` WHERE `project_id` IS NULL AND `id` NOT IN (
  SELECT (
    SELECT u2.`id` FROM `user_match_state` u2
    WHERE u2.`project_id` IS NULL AND u2.`user_id` = u1.`user_id` AND u2.`repo_id` = u1.`repo_id`
    ORDER BY (u2.`action_at` IS NOT NULL) DESC, u2.`action_at` DESC, u2.`id` DESC
    LIMIT 1
  )
  FROM `user_match_state` u1 WHERE u1.`project_id` IS NULL
  GROUP BY u1.`user_id`, u1.`repo_id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_user_match_state_repo_null_project` ON `user_match_state` (`user_id`,`repo_id`) WHERE "user_match_state"."project_id" is null;