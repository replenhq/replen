-- Phase 1 of the semantic-matcher rebuild: add embedding columns to
-- both candidates and project_profiles. We store embeddings as JSON
-- text (SQLite has no native vector type, and 1536-dim float arrays
-- as JSON are ~15 KB per row — acceptable). Cosine similarity is
-- computed JS-side at query time.
--
-- See src/lib/embeddings.ts for the OpenAI text-embedding-3-small
-- pipeline and src/app/api/inventory/today/route.ts for the query-
-- time scoring path.

ALTER TABLE candidates ADD COLUMN embedding TEXT;--> statement-breakpoint
ALTER TABLE candidates ADD COLUMN embedding_content_hash TEXT;--> statement-breakpoint
ALTER TABLE candidates ADD COLUMN embedding_generated_at INTEGER;--> statement-breakpoint
ALTER TABLE project_profiles ADD COLUMN embedding TEXT;--> statement-breakpoint
ALTER TABLE project_profiles ADD COLUMN embedding_content_hash TEXT;--> statement-breakpoint
ALTER TABLE project_profiles ADD COLUMN embedding_generated_at INTEGER;
