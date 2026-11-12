-- +goose Up
-- The inbox of a principal finds the threads that they wrote in, and the
-- documents that they approve, across all documents.
CREATE INDEX comments_author_idx ON comments(author_type, author_id);
CREATE INDEX approval_requests_approver_idx
  ON approval_requests(approver_type, approver_id) WHERE revoked_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS approval_requests_approver_idx;
DROP INDEX IF EXISTS comments_author_idx;
