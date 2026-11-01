-- +goose Up
-- One queued Slack message per approver and reason: to the approver when the
-- owner asks them, or to the owner when the approver decides. A newer event
-- for the same approver replaces a queued one, and the worker reads the
-- current state before it sends.
CREATE TABLE approval_notification_outbox (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  approver_type TEXT NOT NULL CHECK (approver_type IN ('user', 'service_account')),
  approver_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('approval_requested', 'approval_decided')),
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, approver_type, approver_id, reason)
);

CREATE INDEX approval_notification_pending ON approval_notification_outbox(available_at);

-- +goose Down
DROP TABLE approval_notification_outbox;
