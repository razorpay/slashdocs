-- +goose Up
-- A document's review status, set by its editors. Empty means no status.
ALTER TABLE documents
  ADD COLUMN status text NOT NULL DEFAULT ''
  CONSTRAINT documents_status_check CHECK (status IN ('', 'draft', 'in_review', 'approved', 'archived'));

-- +goose Down
ALTER TABLE documents DROP COLUMN status;
