-- +goose Up
-- An approver who edits a document stays an approver, so no version removes
-- approvers or gives them back.
ALTER TABLE approvals DROP COLUMN revoked_by_version_id;
ALTER TABLE approval_requests DROP COLUMN revoked_by_version_id;

-- +goose Down
ALTER TABLE approval_requests ADD COLUMN revoked_by_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN revoked_by_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL;
