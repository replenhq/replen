-- Multi-repo products: repos sharing a product_key are one product, so matching
-- can union the whole product's capabilities (a CV library surfaces in
-- acme-web, not only acme-cv). Auto-derived owner/stem; user-overridable.
ALTER TABLE `project_profiles` ADD COLUMN `product_key` text;
