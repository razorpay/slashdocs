-- +goose Up
-- Approval events for an external system, such as a task tracker. When
-- SLASHDOCS_APPROVAL_WEBHOOK_URL is set, each change to a document's approvals
-- writes one row in the transaction of the change, and a worker posts it to the
-- webhook and deletes it once the webhook accepts it. The id is the idempotency
-- key. There is no foreign key: an event outlives its document.
CREATE TABLE approval_event_outbox (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX approval_event_pending ON approval_event_outbox(available_at);

-- Numbers the events in each payload, so a receiver can order them.
CREATE SEQUENCE approval_event_sequence;

-- +goose Down
DROP SEQUENCE approval_event_sequence;
DROP TABLE approval_event_outbox;
