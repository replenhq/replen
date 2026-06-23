-- Contextual triage signal (the L4 learning loop, made context-aware). The
-- repo-level repo_quality aggregate can't tell "anomalib is great for image
-- projects, wrong for telemetry ones" — the skip is contextual. This adds the
-- matched capability facet; facet_modality + reason_code are added by 0052/0053
-- (kept as separate SINGLE-statement migrations — drizzle's libsql migrator is
-- unreliable on multi-statement files, so each column ADD lives in its own file).
ALTER TABLE `triage_events` ADD COLUMN `matched_facet` text;
