-- Contextual triage signal (the L4 learning loop, made context-aware). The
-- repo-level repo_quality aggregate can't tell "anomalib is great for image
-- projects, wrong for telemetry ones" — the skip is contextual. These columns
-- capture the matched capability facet, its modality, and a structured reason
-- so a future pass can suppress a (repo × modality) collision without globally
-- demoting a repo that's excellent for the right project. All nullable/additive.
ALTER TABLE `triage_events` ADD COLUMN `matched_facet` text;
ALTER TABLE `triage_events` ADD COLUMN `facet_modality` text;
ALTER TABLE `triage_events` ADD COLUMN `reason_code` text;
