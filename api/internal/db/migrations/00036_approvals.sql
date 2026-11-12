-- +goose Up
CREATE TABLE approval_requests (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  approver_type     TEXT NOT NULL CHECK (approver_type IN ('user', 'service_account')),
  approver_id       TEXT NOT NULL,
  requested_by_type TEXT NOT NULL,
  requested_by_id   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);

-- Partial unique index (not a table constraint) so a removed approver can be
-- re-assigned: revoked rows stay for audit without blocking a new assignment.
CREATE UNIQUE INDEX approval_requests_active_uniq
  ON approval_requests(document_id, approver_type, approver_id) WHERE revoked_at IS NULL;

-- A decision vouches for content, not for a version row: sha256 is the content
-- the approver saw, and version_id is the version they decided on. A version
-- with the same content shows the decision; a version with other content does
-- not, so a change resets approvals and a revert restores them.
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  sha256        TEXT NOT NULL,
  approver_type TEXT NOT NULL,
  approver_id   TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note          TEXT NOT NULL DEFAULT '',
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX approvals_active_uniq
  ON approvals(document_id, sha256, approver_type, approver_id) WHERE revoked_at IS NULL;
CREATE INDEX approvals_version_idx ON approvals(version_id);

-- +goose Down
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS approval_requests;
