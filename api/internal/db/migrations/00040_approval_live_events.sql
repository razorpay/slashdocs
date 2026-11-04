-- +goose Up
-- A change to a document's approvers or decisions is an 'approvals' event in
-- the live event log, so open viewers refresh the approval state.
ALTER TABLE document_kv_events DROP CONSTRAINT document_kv_events_kind_check;
ALTER TABLE document_kv_events ADD CONSTRAINT document_kv_events_kind_check
  CHECK (kind IN ('kv', 'document', 'comments', 'presence', 'approvals'));

-- +goose Down
DELETE FROM document_kv_events WHERE kind = 'approvals';
ALTER TABLE document_kv_events DROP CONSTRAINT document_kv_events_kind_check;
ALTER TABLE document_kv_events ADD CONSTRAINT document_kv_events_kind_check
  CHECK (kind IN ('kv', 'document', 'comments', 'presence'));
