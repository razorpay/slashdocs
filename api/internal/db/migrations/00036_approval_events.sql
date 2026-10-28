-- +goose Up
-- An insert-only log of approval changes, one small row per change, written in the same transaction as the change
-- itself. It carries no names, notes or decisions: a reader (a webhook worker, a feed, a change-data-capture connector)
-- only learns that something changed on a document and then reads the real state from the API.
CREATE TABLE approval_events (
  id          BIGSERIAL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN ('requested', 'removed', 'approved', 'rejected', 'revoked', 'version_created')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Old rows are pruned by creation time.
CREATE INDEX approval_events_created_idx ON approval_events(created_at);

-- +goose Down
DROP TABLE IF EXISTS approval_events;
