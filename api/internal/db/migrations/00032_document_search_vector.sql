-- +goose Up
-- search_vector is the title and the current text of a document. Title words
-- rank higher. Search finds matches in its index, so that it does not read the
-- text of every document. Triggers keep it current, also for writes from old
-- servers during a rolling deployment. NULL means that the document is not
-- indexed yet. Servers index older documents in the background after this
-- migration, so that the migration locks the table for a short time only.
ALTER TABLE documents ADD COLUMN search_vector TSVECTOR;

-- +goose StatementBegin
CREATE FUNCTION set_document_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := setweight(to_tsvector('english', NEW.title), 'A')
    || COALESCE((SELECT search_vector FROM versions WHERE id = NEW.current_version_id), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER set_document_search_vector_trigger
BEFORE INSERT OR UPDATE OF title, current_version_id ON documents
FOR EACH ROW EXECUTE FUNCTION set_document_search_vector();

-- The background indexer gives text to older current versions. An update of
-- current_version_id to the same value runs the trigger above.
-- +goose StatementBegin
CREATE FUNCTION refresh_document_search_vector() RETURNS trigger AS $$
BEGIN
  UPDATE documents SET current_version_id = current_version_id
  WHERE id = NEW.document_id AND current_version_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER refresh_document_search_vector_trigger
AFTER UPDATE OF search_text ON versions
FOR EACH ROW EXECUTE FUNCTION refresh_document_search_vector();

CREATE INDEX idx_documents_search_vector ON documents USING GIN (search_vector);

-- +goose Down
DROP INDEX IF EXISTS idx_documents_search_vector;
DROP TRIGGER IF EXISTS refresh_document_search_vector_trigger ON versions;
DROP FUNCTION IF EXISTS refresh_document_search_vector();
DROP TRIGGER IF EXISTS set_document_search_vector_trigger ON documents;
DROP FUNCTION IF EXISTS set_document_search_vector();
ALTER TABLE documents DROP COLUMN IF EXISTS search_vector;
