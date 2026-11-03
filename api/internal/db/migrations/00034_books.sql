-- +goose Up
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
ALTER TABLE versions ADD COLUMN sections_indexed BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX versions_sections_unindexed_idx ON versions (created_at) WHERE NOT sections_indexed;
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

-- +goose Down
DROP TABLE IF EXISTS reading_positions;
DROP TABLE IF EXISTS chapter_reads;
DROP INDEX IF EXISTS versions_sections_unindexed_idx;
ALTER TABLE versions DROP COLUMN IF EXISTS sections_indexed;
DROP TABLE IF EXISTS version_sections;
DROP TABLE IF EXISTS book_outline_versions;
DROP TABLE IF EXISTS books;
