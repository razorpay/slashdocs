-- +goose Up
-- When each reader last read each thread. A thread is unread for a reader
-- while a message by someone else in it is newer than their read time.
CREATE TABLE comment_reads (
  thread_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'service_account')),
  principal_id TEXT NOT NULL CHECK (principal_id <> ''),
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, principal_type, principal_id)
);

COMMENT ON TABLE comment_reads IS
  'One row per (thread, reader): the last time the reader read the thread. Only the root comment of a thread has rows. Readers who never opened a thread have no row, and every message by someone else in it is unread for them.';

-- No secondary index: the primary key is a btree led by thread_id, which
-- covers the join from a document's comments in ListUnreadCommentThreads.

-- +goose Down
DROP TABLE comment_reads;
