ALTER TABLE `candidates` ADD `created_at` integer;
--> statement-breakpoint
-- Backfill the TRUE repo birth date for existing rows from raw_json. ONLY the
-- camelCase `$.createdAt` key is used: it is written exclusively by the GitHub
-- repo-search fetchers (gh-search-recent / historical-search / gh-search) and is
-- always the repo's created_at. Deliberately NOT `$.created_at` (snake_case) —
-- in hn/reddit rows that key is the STORY/post date, which would poison birth
-- dates. Rows without the key (trending/social) stay NULL → no frontier tilt
-- (graceful), and repopulate with a real created_at on the next fetch. ISO8601 →
-- unix seconds (strip the 'T'/'Z' so SQLite's strftime parses it).
UPDATE `candidates`
SET `created_at` = CAST(strftime('%s', replace(replace(json_extract(`raw_json`, '$.createdAt'), 'T', ' '), 'Z', '')) AS INTEGER)
WHERE `created_at` IS NULL
  AND json_extract(`raw_json`, '$.createdAt') IS NOT NULL
  AND strftime('%s', replace(replace(json_extract(`raw_json`, '$.createdAt'), 'T', ' '), 'Z', '')) IS NOT NULL;
