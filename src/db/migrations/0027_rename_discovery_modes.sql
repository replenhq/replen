-- Rename discovery_mode values to plainer English vocabulary used in the
-- UI pill, email, and code constants. The values are user-visible (they
-- render as a tag on each match card and influence the email summary) so
-- the rename keeps DB + code + UI in lockstep.
--
--   serendipity   -> discovered    (broad-net feed: trending, HN, reddit, ...)
--   targeted      -> scouted       (Stage 3 outcome-attributed gh search)
--   bookmark      -> re-checked    (resurfaced from a user's bookmarks)
--
-- 'manual' is preserved as-is; it's only used by admin tooling and was
-- never a public label.
UPDATE `matches` SET `discovery_mode` = 'discovered' WHERE `discovery_mode` = 'serendipity';--> statement-breakpoint
UPDATE `matches` SET `discovery_mode` = 'scouted' WHERE `discovery_mode` = 'targeted';--> statement-breakpoint
UPDATE `matches` SET `discovery_mode` = 're-checked' WHERE `discovery_mode` = 'bookmark';
