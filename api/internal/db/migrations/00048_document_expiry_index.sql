-- +goose Up
-- The sweep finds the documents whose expiry time passed, the oldest first.
-- Few documents have an expiry time, so the index holds only those. The id
-- is in the index because the sweep orders by it too: without it, PostgreSQL
-- sorts all documents that share the oldest time.
--
-- The index is in a migration of its own, so that the lock of the ALTER
-- TABLE before it is not held while the index is built. The build stops the
-- writes to documents while it reads the table.
--
-- It is not built CONCURRENTLY. Servers that start at the same time wait for
-- the advisory lock of the one that migrates, and a server that waits holds
-- a snapshot. A concurrent build waits for that snapshot, so PostgreSQL
-- finds a deadlock and stops a server.
SET LOCAL lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS documents_expires_at_idx
  ON documents(expires_at, id) WHERE expires_at IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS documents_expires_at_idx;
