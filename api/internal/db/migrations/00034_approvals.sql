-- +goose Up
CREATE TABLE approval_requests (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  approver_type    TEXT NOT NULL,
  approver_id      TEXT NOT NULL,
  requested_by_type TEXT NOT NULL,
  requested_by_id   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ
);

-- Partial unique index (not a table constraint) so a removed approver can be
-- re-assigned: revoked rows stay for audit without blocking a new assignment.
CREATE UNIQUE INDEX approval_requests_active_uniq
  ON approval_requests(document_id, approver_type, approver_id) WHERE revoked_at IS NULL;
CREATE INDEX approval_requests_document_idx ON approval_requests(document_id);

CREATE TABLE approvals (
  id                      TEXT PRIMARY KEY,
  document_id             TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id              TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  approver_type           TEXT NOT NULL,
  approver_id             TEXT NOT NULL,
  decision                TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  decided_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The version that received the approver's explicit decision, when this row
  -- was copied forward on a version push. NULL for explicit decisions.
  carried_from_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
  revoked_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX approvals_active_uniq
  ON approvals(version_id, approver_type, approver_id) WHERE revoked_at IS NULL;
CREATE INDEX approvals_document_idx ON approvals(document_id);
CREATE INDEX approvals_version_idx ON approvals(version_id);

-- +goose Down
DROP INDEX IF EXISTS approvals_version_idx;
DROP INDEX IF EXISTS approvals_document_idx;
DROP INDEX IF EXISTS approvals_active_uniq;
DROP TABLE IF EXISTS approvals;
DROP INDEX IF EXISTS approval_requests_document_idx;
DROP INDEX IF EXISTS approval_requests_active_uniq;
DROP TABLE IF EXISTS approval_requests;
