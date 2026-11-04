-- +goose Up
-- A version whose author is an approver removes that approver, with their
-- decisions. The removal names the version, so that a version that undoes
-- the author's edits can give the approver and the decisions back.
ALTER TABLE approval_requests ADD COLUMN revoked_by_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN revoked_by_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE approvals DROP COLUMN revoked_by_version_id;
ALTER TABLE approval_requests DROP COLUMN revoked_by_version_id;
