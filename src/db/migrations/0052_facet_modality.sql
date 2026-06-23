-- Adds triage_events.facet_modality (single-statement; pairs with 0050 matched_facet
-- and 0053 reason_code). Single-statement on purpose — see 0050's note.
ALTER TABLE `triage_events` ADD COLUMN `facet_modality` text;
