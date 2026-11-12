-- +goose Up
-- A retry skips the providers that delivered the message or failed permanently.
ALTER TABLE comment_notification_outbox ADD COLUMN finished_providers text[] NOT NULL DEFAULT '{}';
ALTER TABLE document_access_notification_outbox ADD COLUMN finished_providers text[] NOT NULL DEFAULT '{}';
ALTER TABLE document_access_request_notification_outbox ADD COLUMN finished_providers text[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE document_access_request_notification_outbox DROP COLUMN finished_providers;
ALTER TABLE document_access_notification_outbox DROP COLUMN finished_providers;
ALTER TABLE comment_notification_outbox DROP COLUMN finished_providers;
