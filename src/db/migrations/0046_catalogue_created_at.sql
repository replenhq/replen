-- Recency/trending signal: store each catalogue repo's creation date so a
-- recently-created, capability-relevant repo (a "rising gem") can rank up
-- instead of being buried under the all-time star leader.
ALTER TABLE `catalogue_repos` ADD COLUMN `created_at` integer;
