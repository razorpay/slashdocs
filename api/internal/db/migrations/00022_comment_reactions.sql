-- +goose Up
CREATE TABLE comment_reactions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'service_account')),
  principal_id TEXT NOT NULL CHECK (principal_id <> ''),
  emoji TEXT NOT NULL CHECK (emoji IN ('+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, principal_type, principal_id, emoji)
);

COMMENT ON TABLE comment_reactions IS
  'Lightweight acknowledgements on comments and replies. One row per (comment, principal, emoji); the primary key makes adding a reaction idempotent and removing one a primary-key delete.';
COMMENT ON COLUMN comment_reactions.emoji IS
  'Stable ASCII slug from a fixed set, not a literal emoji character, so the value is URL-safe and each client chooses its own glyph. The CHECK keeps an old pod or a direct SQL writer from storing a slug clients cannot render.';

-- No secondary index: the primary key is a btree led by comment_id, which
-- already covers the comment-scoped bulk read in ListCommentReactions.

-- +goose Down
DROP TABLE comment_reactions;
