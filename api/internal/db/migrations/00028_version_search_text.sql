-- +goose Up
-- search_text is the text that a reader sees in a version, for full-text
-- search. NULL means that the version is not indexed yet. Servers index older
-- current versions in the background after this migration.
ALTER TABLE versions ADD COLUMN search_text TEXT;
ALTER TABLE versions ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', COALESCE(search_text, ''))) STORED;

-- +goose Down
ALTER TABLE versions DROP COLUMN search_vector;
ALTER TABLE versions DROP COLUMN search_text;
