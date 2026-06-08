-- Faceted matching (Phase 1). Per-capability embedding vectors for a project,
-- stored as JSON { hash, facets: [{ label, vec }] }. The existing `embedding`
-- column stays as the project centroid (used for competitor detection +
-- cross-user project-to-project similarity); facet vectors are matched on a
-- max-over-facets basis so a library that fills ONE capability surfaces even
-- when it's far from the project's blended centroid.
ALTER TABLE `project_profiles` ADD COLUMN `facet_embeddings` text;
