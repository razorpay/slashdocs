-- +goose Up
-- An edit is an operation in the log of its document, and a version is a
-- checkpoint. documents.seq is the number of the last operation: the live
-- document is the source at that seq. The newest version of a document is
-- open while people type, and its sealed_at is NULL. Its blob is a snapshot
-- of the live document at versions.seq, and the operations after that seq
-- complete it. A sealed version holds its content, and its seq is the seq of
-- the document when it was sealed.
--
-- The defaults are for the rows that exist: no row is written here.
--
-- versions.seq then has no default. A server of the release before does
-- not know the log: it would save a version on the snapshot of an open
-- version and remove the text that people typed after it. During a rolling
-- deploy such a server cannot save a version: its push or edit fails with a
-- server error, and nothing is lost. The browser sends typed text again by
-- itself. An agent or a person sends a push or an edit again.
ALTER TABLE documents ADD COLUMN seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE versions ADD COLUMN seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE versions ALTER COLUMN seq DROP DEFAULT;
ALTER TABLE versions ADD COLUMN sealed_at TIMESTAMPTZ DEFAULT now();
-- A push in the middle of a sitting seals the sitting before it. When the
-- people type on after the push, their next version names the first version
-- of the sitting in sitting_id. History shows the versions of one sitting as
-- one row.
ALTER TABLE versions ADD COLUMN sitting_id TEXT;

-- The background task that seals versions reads the open ones. No version
-- is open when the index is made, so it has no row. The build holds a SHARE
-- lock on versions for one read of the rows of the table, without the HTML,
-- which is in the blob store, and without the search text, which is in
-- TOAST. Writes of versions wait for that time, and reads do not. The time
-- grows with the count of versions, and nobody measured it on the
-- production table.
CREATE INDEX idx_versions_open ON versions(document_id) WHERE sealed_at IS NULL;

-- replacements turn the source at seq - 1 into the source at seq. They are
-- NULL when the log does not hold them: the operation is then too large, and
-- the version that it sealed holds the source. sum is the CRC-32 of the
-- source at seq. typed is true for an operation of the browser editor. A
-- retry of an operation finds it by client_op_id. The operations of a sealed
-- version lose their replacements 10 minutes after the seal, and their rows
-- are deleted after 7 days: until then a retry learns that the document has
-- the operation.
CREATE TABLE document_ops (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  client_op_id TEXT,
  typed BOOLEAN NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  replacements JSONB,
  sum BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq),
  UNIQUE (document_id, client_op_id)
);
-- The last operation of a version gives the time of its last edit.
CREATE INDEX idx_document_ops_version ON document_ops(version_id, seq);
-- The background task reads the old operations that still have their
-- replacements, and the older ones that do not, by age.
CREATE INDEX idx_document_ops_held ON document_ops(created_at) WHERE replacements IS NOT NULL;
CREATE INDEX idx_document_ops_emptied ON document_ops(created_at) WHERE replacements IS NULL;
-- A decision is refused while another person typed in the last seconds. The
-- check reads only the newest operations of the document.
CREATE INDEX idx_document_ops_recent ON document_ops(document_id, created_at);

-- The people whose operations a version holds, which History shows after
-- the operations are deleted.
CREATE TABLE version_authors (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, author_type, author_id)
);

-- A text comment follows its text: comments.anchor_seq is the seq of the
-- document that its anchor is on. The server moves the anchor to the live
-- document after each change. It is NULL for a point, a reply, and a comment
-- from before this release, which keep their anchors.
ALTER TABLE comments ADD COLUMN anchor_seq BIGINT;

-- versions.client_change_id is not used from this release on. The next
-- migration drops it and its index.

-- +goose Down
-- An open version has no content of its own, so the servers must seal every
-- version before the log goes.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM versions WHERE sealed_at IS NULL) THEN
    RAISE EXCEPTION 'a version is open: seal every version before this migration goes down';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE comments DROP COLUMN anchor_seq;
DROP TABLE version_authors;
DROP TABLE document_ops;
DROP INDEX idx_versions_open;
ALTER TABLE versions DROP COLUMN sitting_id;
ALTER TABLE versions DROP COLUMN sealed_at;
ALTER TABLE versions DROP COLUMN seq;
ALTER TABLE documents DROP COLUMN seq;
