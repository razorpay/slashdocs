-- +goose Up
-- Wait at most 5 s for each lock (goose runs this file in one transaction).
-- Otherwise a long read on versions from an old pod would queue the ALTER
-- TABLE below, and every new versions read would queue behind it. On a
-- timeout the migration fails, the server does not start, and the deploy
-- retries.
SET LOCAL lock_timeout = '5s';
-- A book is a folder read in order. Its outline is versioned like documents.
CREATE TABLE books (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL UNIQUE REFERENCES folders(id) ON DELETE CASCADE,
  current_outline_version_id TEXT NULL,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE book_outline_versions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  number INT NOT NULL CHECK (number > 0),
  outline JSONB NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (book_id, number)
);
-- Sections of a version: hashed once at publish so "what changed" is a lookup.
CREATE TABLE version_sections (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  ord INT NOT NULL,
  section_id TEXT NOT NULL,
  title TEXT NOT NULL,
  level INT NOT NULL,
  text_hash TEXT NOT NULL,
  words INT NOT NULL CHECK (words >= 0),
  PRIMARY KEY (version_id, ord)
);
-- Reading state belongs to human users only.
CREATE TABLE chapter_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seen_version_id TEXT NULL REFERENCES versions(id) ON DELETE SET NULL,
  last_read_version_id TEXT NULL REFERENCES versions(id) ON DELETE SET NULL,
  furthest_progression REAL NOT NULL DEFAULT 0 CHECK (furthest_progression BETWEEN 0 AND 1),
  reached_end_at TIMESTAMPTZ NULL,
  done_at TIMESTAMPTZ NULL,
  last_opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id)
);
CREATE TABLE reading_positions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (char_length(device_id) BETWEEN 8 AND 64),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL DEFAULT '',
  anchor JSONB NOT NULL DEFAULT '{}',
  progression REAL NOT NULL CHECK (progression BETWEEN 0 AND 1),
  client_ts TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id, device_id)
);
CREATE INDEX reading_positions_user_book_idx ON reading_positions (user_id, book_id, client_ts DESC);
-- Every foreign key leads an index, so a cascading document, version or book
-- delete looks rows up instead of scanning these tables once per deleted row.
-- The tables are new and empty, so building the indexes here is instant.
CREATE INDEX chapter_reads_document_idx ON chapter_reads (document_id);
CREATE INDEX chapter_reads_seen_version_idx ON chapter_reads (seen_version_id) WHERE seen_version_id IS NOT NULL;
CREATE INDEX chapter_reads_last_read_version_idx ON chapter_reads (last_read_version_id) WHERE last_read_version_id IS NOT NULL;
CREATE INDEX reading_positions_book_idx ON reading_positions (book_id);
CREATE INDEX reading_positions_document_idx ON reading_positions (document_id);
CREATE INDEX reading_positions_version_idx ON reading_positions (version_id);
-- Last, so that the ACCESS EXCLUSIVE lock it takes on versions (held until
-- commit) blocks document reads for as little time as possible. A constant
-- default makes it a catalog-only change; no index is built on versions: the
-- startup backfill reaches unindexed versions through the join to books.
ALTER TABLE versions ADD COLUMN sections_indexed BOOLEAN NOT NULL DEFAULT false;

-- +goose Down
DROP TABLE IF EXISTS reading_positions;
DROP TABLE IF EXISTS chapter_reads;
ALTER TABLE versions DROP COLUMN IF EXISTS sections_indexed;
DROP TABLE IF EXISTS version_sections;
DROP TABLE IF EXISTS book_outline_versions;
DROP TABLE IF EXISTS books;
