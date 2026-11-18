-- +goose NO TRANSACTION
-- +goose Up
-- The delete of a document, a version or a comment makes PostgreSQL look for
-- the rows that point to it. These columns had no index that starts with
-- them, or only an index of the rows that are not revoked, so each look-up
-- read a whole table. The sweep of expired documents deletes many of them.
--
-- The migration has no transaction, so each index releases the lock on its
-- table when it is built, and a server that stops in the middle keeps the
-- indexes that are done: IF NOT EXISTS passes over them at the next start.
-- A build stops the writes to its table while it reads the table.
--
-- The indexes are not built CONCURRENTLY, for the reason that migration 48
-- gives.
SET lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_versions_parent ON versions(parent_version_id);
CREATE INDEX IF NOT EXISTS idx_comments_created_on_version ON comments(created_on_version_id);
CREATE INDEX IF NOT EXISTS idx_comments_root ON comments(root_comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_placements_version ON comment_placements(version_id);
CREATE INDEX IF NOT EXISTS idx_documents_current_version ON documents(current_version_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_document ON approval_requests(document_id);
CREATE INDEX IF NOT EXISTS idx_approvals_document ON approvals(document_id);
CREATE INDEX IF NOT EXISTS idx_document_notification_mutes_document ON document_notification_mutes(document_id);
RESET lock_timeout;

-- +goose Down
DROP INDEX IF EXISTS idx_document_notification_mutes_document;
DROP INDEX IF EXISTS idx_approvals_document;
DROP INDEX IF EXISTS idx_approval_requests_document;
DROP INDEX IF EXISTS idx_documents_current_version;
DROP INDEX IF EXISTS idx_comment_placements_version;
DROP INDEX IF EXISTS idx_comments_root;
DROP INDEX IF EXISTS idx_comments_created_on_version;
DROP INDEX IF EXISTS idx_versions_parent;
