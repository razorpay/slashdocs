-- +goose Up
CREATE TABLE document_access_notification_outbox (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('direct', 'opened')),
  reason TEXT NOT NULL CHECK (reason IN ('access_shared', 'access_updated', 'access_removed')),
  previous_role TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, recipient_id, source)
);

CREATE INDEX document_access_notification_pending
  ON document_access_notification_outbox(available_at);

ALTER TABLE comment_notification_outbox DROP CONSTRAINT comment_notification_outbox_reason_check;
ALTER TABLE comment_notification_outbox ADD CONSTRAINT comment_notification_outbox_reason_check
  CHECK (reason IN ('mention', 'reply', 'owner'));

-- +goose Down
DELETE FROM comment_notification_outbox WHERE reason = 'reply';
ALTER TABLE comment_notification_outbox DROP CONSTRAINT comment_notification_outbox_reason_check;
ALTER TABLE comment_notification_outbox ADD CONSTRAINT comment_notification_outbox_reason_check
  CHECK (reason IN ('mention', 'owner'));
DROP TABLE document_access_notification_outbox;
