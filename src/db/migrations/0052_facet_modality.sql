-- Fix for 0050 (multi-statement migration only ran its first ALTER under the
-- libsql migrator). facet_modality, split out as a single-statement migration.
ALTER TABLE `triage_events` ADD COLUMN `facet_modality` text;
