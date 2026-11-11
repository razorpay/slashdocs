-- name: MarkCommentThreadRead :execrows
-- Only a root comment of the named document takes a read mark, so a reply id
-- or a thread of another document marks nothing.
INSERT INTO comment_reads(thread_id, principal_type, principal_id)
SELECT c.id, @principal_type, @principal_id
FROM comments c
WHERE c.id = @thread_id AND c.document_id = @document_id AND c.parent_comment_id IS NULL
ON CONFLICT (thread_id, principal_type, principal_id) DO UPDATE SET read_at = now();

-- name: ListUnreadCommentThreads :many
-- The threads of a document that have a message by someone other than the
-- reader, newer than the reader's read time.
SELECT DISTINCT c.root_comment_id
FROM comments c
LEFT JOIN comment_reads r
  ON r.thread_id = c.root_comment_id
  AND r.principal_type = @principal_type
  AND r.principal_id = @principal_id
WHERE c.document_id = @document_id
  AND NOT (c.author_type = @principal_type AND c.author_id = @principal_id)
  AND (r.read_at IS NULL OR c.created_at > r.read_at);
