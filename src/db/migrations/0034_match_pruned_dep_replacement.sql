-- Pipeline v2 / Sprint 2 cross-match consistency: capture the name of
-- the suggested replacement package on prune-action='replace' matches.
-- Without this column the replacement only existed as prose inside
-- writeup_md, making cross-match consistency checks regex-fragile.
--
-- Cheap to add (single nullable text column). Backfill via a follow-up
-- script if needed; existing prune-replace rows can stay null and
-- those just won't participate in conflict detection.
ALTER TABLE `matches` ADD `pruned_dep_replacement` text;
