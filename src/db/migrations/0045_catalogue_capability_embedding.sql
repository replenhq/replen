-- Phase 7 — capability adjacency. Store each capability label's own embedding
-- so we can find catalogue capabilities ADJACENT to a project's capabilities
-- (near but distinct) and surface their best library as an exploratory match.
ALTER TABLE `catalogue_capabilities` ADD COLUMN `embedding` text;
