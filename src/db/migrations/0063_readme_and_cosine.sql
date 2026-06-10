-- Matching quality: README head stored per catalogue repo (embedded into the
-- match vector — title+description was the retrieval ceiling), and the cosine
-- the candidate surfaced at, recorded on triage (the label that lets the
-- relevance floor calibrate itself per project).
ALTER TABLE `catalogue_repos` ADD COLUMN `readme_head` text;
--> statement-breakpoint
ALTER TABLE `triage_events` ADD COLUMN `matched_cosine` real;
