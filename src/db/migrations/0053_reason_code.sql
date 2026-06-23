-- Adds triage_events.reason_code (single-statement; pairs with 0050 matched_facet
-- and 0052 facet_modality). Single-statement on purpose — see 0050's note.
ALTER TABLE `triage_events` ADD COLUMN `reason_code` text;
