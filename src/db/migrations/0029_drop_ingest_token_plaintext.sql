-- Legacy plaintext ingest_token column. Every value was hashed and zeroed
-- by the one-shot boot-time backfill in src/db/client.ts (which is removed
-- in the same change as this migration). All reads/writes now go through
-- ingestTokenHash. The column has been dead weight in the schema since
-- migration 0013 wrote ingest_token_hash; this drop closes the door.
--
-- libsql/sqlite supports ALTER TABLE ... DROP COLUMN since SQLite 3.35
-- (Mar 2021); our prod libsql is well past that.
ALTER TABLE user_settings DROP COLUMN ingest_token;
