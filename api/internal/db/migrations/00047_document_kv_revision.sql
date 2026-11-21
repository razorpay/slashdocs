ALTER TABLE documents
ADD COLUMN kv_revision BIGINT NOT NULL DEFAULT 0;

-- Preserve the highest revision already allocated for each document.
UPDATE documents d
SET kv_revision = GREATEST(
  COALESCE((
    SELECT MAX(kv.revision)
    FROM document_kv kv
    WHERE kv.document_id = d.id
  ), 0),
  COALESCE((
    SELECT MAX(e.revision)
    FROM document_kv_events e
    WHERE e.document_id = d.id
  ), 0)
);
