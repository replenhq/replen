-- Fix for 0050: reason_code, as a single-statement migration (the libsql
-- migrator only applies the first statement of a multi-statement file).
ALTER TABLE `triage_events` ADD COLUMN `reason_code` text;
