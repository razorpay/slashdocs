-- +goose Up
-- The KV event log becomes the document's live event log: KV changes keep
-- kind 'kv', while 'document', 'comments', and 'presence' events share the
-- same per-document revision sequence and SSE stream.
ALTER TABLE document_kv_events
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'kv'
    CHECK (kind IN ('kv', 'document', 'comments', 'presence')),
  ADD COLUMN data JSONB;

-- Presence events are short-lived; this index serves the snapshot read and
-- the pruning delete.
CREATE INDEX document_kv_events_presence_idx
  ON document_kv_events(document_id, updated_at)
  WHERE kind = 'presence';

-- +goose Down
DROP INDEX IF EXISTS document_kv_events_presence_idx;
DELETE FROM document_kv_events WHERE kind <> 'kv';
ALTER TABLE document_kv_events DROP COLUMN data, DROP COLUMN kind;
