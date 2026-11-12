-- +goose Up
CREATE TABLE notification_preferences (
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'service_account')),
  principal_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (principal_type, principal_id)
);
CREATE TABLE document_notification_mutes (
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'service_account')),
  principal_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (principal_type, principal_id, document_id)
);
CREATE TABLE comment_notification_outbox (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('mention', 'owner')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, recipient_id)
);
CREATE INDEX comment_notification_pending ON comment_notification_outbox(available_at);
ALTER TABLE users ADD COLUMN next_notification_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- +goose Down
ALTER TABLE users DROP COLUMN next_notification_at;
DROP TABLE comment_notification_outbox;
DROP TABLE document_notification_mutes;
DROP TABLE notification_preferences;
