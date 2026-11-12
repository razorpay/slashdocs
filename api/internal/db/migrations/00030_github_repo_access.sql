-- +goose Up
-- Caches whether a connected user can read a GitHub repository, so the
-- author check on document GitHub reads does not use the authors' GitHub
-- rate limit on every view. Owner and repo are lowercase because GitHub
-- names are case-insensitive.
CREATE TABLE github_repo_access (
  user_id TEXT NOT NULL REFERENCES github_connections(user_id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  can_read BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, owner, repo),
  CHECK (owner = lower(owner) AND repo = lower(repo))
);

-- +goose Down
DROP TABLE IF EXISTS github_repo_access;
