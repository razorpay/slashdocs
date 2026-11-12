-- name: ListCommentReactions :many
-- Ordering by created_at before emoji lets the JSON layer aggregate in
-- first-reaction order, so the emoji a thread used first stays leftmost.
SELECT r.comment_id, r.principal_type, r.principal_id, r.emoji,
  COALESCE(u.email, '') AS principal_email,
  COALESCE(u.name, sa.name, '') AS principal_name
FROM comment_reactions r
LEFT JOIN users u ON r.principal_type = 'user' AND r.principal_id = u.id
LEFT JOIN service_accounts sa ON r.principal_type = 'service_account' AND r.principal_id = sa.id
WHERE r.comment_id = ANY(@comment_ids::text[])
ORDER BY r.comment_id, r.created_at, r.emoji, r.principal_type, r.principal_id;

-- name: PutCommentReaction :exec
INSERT INTO comment_reactions(comment_id, principal_type, principal_id, emoji)
VALUES(@comment_id, @principal_type, @principal_id, @emoji)
ON CONFLICT DO NOTHING;

-- name: DeleteCommentReaction :exec
DELETE FROM comment_reactions
WHERE comment_id = @comment_id
  AND principal_type = @principal_type
  AND principal_id = @principal_id
  AND emoji = @emoji;
