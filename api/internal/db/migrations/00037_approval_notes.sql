-- +goose Up
-- Reviewers explain what needs to change when they request changes. The note
-- is optional on an approval and required by the API for changes_requested.
ALTER TABLE approvals ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE approvals DROP COLUMN IF EXISTS note;
