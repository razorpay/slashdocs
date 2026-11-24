-- +goose Up
-- ALTER TABLE needs a lock that stops every read and write of documents. It
-- holds the lock for a moment, but it waits for a long transaction that uses
-- the table, and all other requests then wait behind it. With the timeout
-- the migration fails after 10 seconds, the server stops, and its next start
-- tries again.
SET LOCAL lock_timeout = '10s';

-- A document with an expiry time is deleted after it. A document without one
-- is kept. The column has no default, so PostgreSQL does not rewrite the
-- table.
ALTER TABLE documents ADD COLUMN expires_at TIMESTAMPTZ;

-- How many times editors changed the expiry since the owner set it. An editor
-- changes it a few times only, and the owner without a limit. A default that
-- is a constant does not rewrite the table either.
ALTER TABLE documents ADD COLUMN expiry_editor_changes SMALLINT NOT NULL DEFAULT 0;

-- The deleted documents whose blobs are still in the blob store. A row
-- outlives its document, so it has no foreign key. A server takes a row with
-- a lease: it moves available_at forward and counts the attempt.
CREATE TABLE blob_deletions (
  document_id TEXT PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A server takes the document that waits the longest. The table is new and
-- empty, so the index needs no separate migration.
CREATE INDEX blob_deletions_queued_idx ON blob_deletions(queued_at, document_id);

-- +goose Down
DROP TABLE IF EXISTS blob_deletions;
ALTER TABLE documents DROP COLUMN IF EXISTS expiry_editor_changes;
ALTER TABLE documents DROP COLUMN IF EXISTS expires_at;
