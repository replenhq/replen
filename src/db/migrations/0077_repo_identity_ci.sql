-- F11: collapse case-variant duplicate repos into one canonical row, then make
-- repo identity case-insensitive. GitHub owner/name are ASCII and case-
-- insensitive, so "Owner/Repo" and "owner/repo" are the SAME repo,
-- but the old UNIQUE(owner,name) index let both rows exist - splitting safety
-- scans, the README index, and per-user match/triage/learning state across two
-- ids. This migration merges each such group into a survivor, repoints every FK
-- child (deduping the unique-constraint children so no repoint can collide),
-- deletes the redundant rows, then swaps the case-sensitive unique index for a
-- case-insensitive one. General (handles N-row groups across many users) and
-- idempotent (after the swap no group remains, so a re-run is a no-op).

-- 1. Build the loser -> survivor map. Survivor = freshest sighting per lower-key
--    group (max last_seen_at, tie-broken by max id). A regular table (not TEMP)
--    so it survives across statement-breakpoints irrespective of how the runner
--    manages the connection; dropped at the end.
DROP TABLE IF EXISTS `_f11_merge`;--> statement-breakpoint
CREATE TABLE `_f11_merge` AS
SELECT r.`id` AS loser_id,
  (SELECT s.`id` FROM `repos` s
   WHERE lower(s.`owner`) = lower(r.`owner`) AND lower(s.`name`) = lower(r.`name`)
   ORDER BY s.`last_seen_at` DESC, s.`id` DESC LIMIT 1) AS survivor_id
FROM `repos` r;--> statement-breakpoint
DELETE FROM `_f11_merge` WHERE loser_id = survivor_id;--> statement-breakpoint

-- 2. Children with NO unique constraint on repo_id: plain repoint.
UPDATE `safety_scans` SET `repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `safety_scans`.`repo_id`)
  WHERE `repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint
UPDATE `triage_events` SET `repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `triage_events`.`repo_id`)
  WHERE `repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint
UPDATE `matches` SET `repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `matches`.`repo_id`)
  WHERE `repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint
UPDATE `triage_insights` SET `via_candidate_repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `triage_insights`.`via_candidate_repo_id`)
  WHERE `via_candidate_repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint

-- 3. repo_quality: repo_id is the PRIMARY KEY (one row per repo). Keep exactly
--    one best row per survivor across the survivor's own row AND every loser's
--    row (best = most recently updated), then repoint. Keep-best-then-repoint
--    (not "drop loser if survivor already has one") so a 3+ row group where two
--    losers both carry a quality row can never collide on the PK after repoint.
DELETE FROM `repo_quality`
WHERE (`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR `repo_id` IN (SELECT survivor_id FROM `_f11_merge`))
  AND `repo_id` NOT IN (
    SELECT (
      SELECT b.`repo_id` FROM `repo_quality` b
      WHERE (b.`repo_id` = g.eff_repo OR b.`repo_id` IN (SELECT loser_id FROM `_f11_merge` WHERE survivor_id = g.eff_repo))
      ORDER BY b.`updated_at` DESC, b.`repo_id` DESC LIMIT 1
    )
    FROM (
      SELECT DISTINCT COALESCE((SELECT survivor_id FROM `_f11_merge` WHERE loser_id = c.`repo_id`), c.`repo_id`) AS eff_repo
      FROM `repo_quality` c
      WHERE c.`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR c.`repo_id` IN (SELECT survivor_id FROM `_f11_merge`)
    ) g
  );--> statement-breakpoint
UPDATE `repo_quality` SET `repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `repo_quality`.`repo_id`)
  WHERE `repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint

-- 4. repo_indexes: UNIQUE(repo_id, index_version). Keep one best row per
--    (survivor, index_version) across survivor + all losers (best = newest
--    built_at), then repoint. Same keep-best-per-group shape so two losers that
--    share a version the survivor lacks can't collide on the unique index.
DELETE FROM `repo_indexes`
WHERE (`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR `repo_id` IN (SELECT survivor_id FROM `_f11_merge`))
  AND `id` NOT IN (
    SELECT (
      SELECT b.`id` FROM `repo_indexes` b
      WHERE (b.`repo_id` = g.eff_repo OR b.`repo_id` IN (SELECT loser_id FROM `_f11_merge` WHERE survivor_id = g.eff_repo))
        AND b.`index_version` = g.index_version
      ORDER BY b.`built_at` DESC, b.`id` DESC LIMIT 1
    )
    FROM (
      SELECT DISTINCT COALESCE((SELECT survivor_id FROM `_f11_merge` WHERE loser_id = c.`repo_id`), c.`repo_id`) AS eff_repo,
        c.`index_version` AS index_version
      FROM `repo_indexes` c
      WHERE c.`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR c.`repo_id` IN (SELECT survivor_id FROM `_f11_merge`)
    ) g
  );--> statement-breakpoint
UPDATE `repo_indexes` SET `repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `repo_indexes`.`repo_id`)
  WHERE `repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint

-- 5. user_match_state: UNIQUE(user,repo,project) + partial UNIQUE(user,repo)
--    WHERE project IS NULL. Keep exactly one best row per (user, survivor_repo,
--    project-slot) across the survivor's own rows AND every loser's rows, then
--    repoint. "Best" = action-bearing first (action_at DESC, NULL last), then
--    newest id. This can never leave two rows that would violate either index.
DELETE FROM `user_match_state`
WHERE (`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR `repo_id` IN (SELECT survivor_id FROM `_f11_merge`))
  AND `id` NOT IN (
    SELECT (
      SELECT b.`id` FROM `user_match_state` b
      WHERE (b.`repo_id` = g.eff_repo OR b.`repo_id` IN (SELECT loser_id FROM `_f11_merge` WHERE survivor_id = g.eff_repo))
        AND b.`user_id` = g.user_id
        AND (b.`project_id` = g.project_id OR (b.`project_id` IS NULL AND g.project_id IS NULL))
      ORDER BY COALESCE(b.`action_at`, -1) DESC, b.`id` DESC LIMIT 1
    )
    FROM (
      SELECT DISTINCT c.`user_id` AS user_id,
        COALESCE((SELECT survivor_id FROM `_f11_merge` WHERE loser_id = c.`repo_id`), c.`repo_id`) AS eff_repo,
        c.`project_id` AS project_id
      FROM `user_match_state` c
      WHERE c.`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR c.`repo_id` IN (SELECT survivor_id FROM `_f11_merge`)
    ) g
  );--> statement-breakpoint
UPDATE `user_match_state` SET `repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `user_match_state`.`repo_id`)
  WHERE `repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint

-- 6. resurface_attempts: UNIQUE(user,repo,project), project NOT NULL. Same
--    keep-one-best-per-group repoint; "best" = newest attempt (attempted_at, id).
DELETE FROM `resurface_attempts`
WHERE (`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR `repo_id` IN (SELECT survivor_id FROM `_f11_merge`))
  AND `id` NOT IN (
    SELECT (
      SELECT b.`id` FROM `resurface_attempts` b
      WHERE (b.`repo_id` = g.eff_repo OR b.`repo_id` IN (SELECT loser_id FROM `_f11_merge` WHERE survivor_id = g.eff_repo))
        AND b.`user_id` = g.user_id
        AND b.`project_id` = g.project_id
      ORDER BY b.`attempted_at` DESC, b.`id` DESC LIMIT 1
    )
    FROM (
      SELECT DISTINCT c.`user_id` AS user_id,
        COALESCE((SELECT survivor_id FROM `_f11_merge` WHERE loser_id = c.`repo_id`), c.`repo_id`) AS eff_repo,
        c.`project_id` AS project_id
      FROM `resurface_attempts` c
      WHERE c.`repo_id` IN (SELECT loser_id FROM `_f11_merge`) OR c.`repo_id` IN (SELECT survivor_id FROM `_f11_merge`)
    ) g
  );--> statement-breakpoint
UPDATE `resurface_attempts` SET `repo_id` = (SELECT survivor_id FROM `_f11_merge` WHERE loser_id = `resurface_attempts`.`repo_id`)
  WHERE `repo_id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint

-- 7. Remove the now-orphaned loser repo rows, drop the scratch map.
DELETE FROM `repos` WHERE `id` IN (SELECT loser_id FROM `_f11_merge`);--> statement-breakpoint
DROP TABLE `_f11_merge`;--> statement-breakpoint

-- 8. Swap the case-sensitive unique index for a case-insensitive one so a future
--    insert of a case-variant conflicts instead of minting a duplicate row.
DROP INDEX IF EXISTS `uniq_repo`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_repo_ci` ON `repos` (lower(`owner`), lower(`name`));
