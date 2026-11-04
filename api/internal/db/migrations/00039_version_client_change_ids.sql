-- +goose Up
-- The browser editor names each save with a client change id. A retry of a
-- save that reached the server finds the version that the save made, so
-- that the retry does not make a second one.
ALTER TABLE versions ADD COLUMN client_change_id TEXT;

CREATE UNIQUE INDEX versions_client_change_uniq ON versions(document_id, client_change_id)
  WHERE client_change_id IS NOT NULL;

-- +goose Down
DROP INDEX versions_client_change_uniq;
ALTER TABLE versions DROP COLUMN client_change_id;
