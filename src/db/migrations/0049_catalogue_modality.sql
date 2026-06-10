-- Data modality of a catalogue repo (JSON string[] from the closed set in
-- src/projects/modality.ts: image/video/timeseries/tabular/text/audio/
-- geospatial/graph/3d/code/network). Drives the cross-modal gate: an image
-- anomaly-detection library never matches a telemetry "anomaly detection"
-- capability. Populated deterministically from topics + the classify.ts LLM
-- pass; NULL means unknown → the gate stays open (no over-suppression).
ALTER TABLE `catalogue_repos` ADD COLUMN `modality` text;
