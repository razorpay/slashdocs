-- name: InsertComment :one
INSERT INTO comments(id,document_id,created_on_version_id,author_type,author_id,author_email,author_name,body,selected_text,anchor_json,status,root_comment_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$1)
RETURNING created_at;

-- name: InsertCommentReply :one
INSERT INTO comments(id,document_id,created_on_version_id,author_type,author_id,author_email,author_name,body,selected_text,anchor_json,status,parent_comment_id,root_comment_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,'','{}'::jsonb,'open',$9,$10)
RETURNING created_at;

-- name: ListComments :many
SELECT id,document_id,created_on_version_id,author_type,author_id,author_email,author_name,body,selected_text,anchor_json,status,parent_comment_id,root_comment_id,created_at,resolved_at,edited_at
FROM comments WHERE document_id= @document_id AND (@status::text='' OR status= @status) AND (@version_id::text='' OR created_on_version_id= @version_id) ORDER BY created_at, id;

-- name: InsertCommentMention :exec
INSERT INTO comment_mentions(comment_id, principal_type, principal_id, offset_utf16, length_utf16, label_text)
VALUES(
  @comment_id,
  @principal_type,
  @principal_id,
  CAST(@offset_utf16::bigint AS integer),
  CAST(@length_utf16::bigint AS integer),
  @label_text
);

-- name: DeleteCommentMentions :exec
DELETE FROM comment_mentions WHERE comment_id = $1;

-- name: ListCommentMentions :many
SELECT
  cm.comment_id,
  cm.principal_type,
  cm.principal_id,
  COALESCE(u.email, '') AS principal_email,
  COALESCE(u.name, sa.name, '') AS principal_name,
  COALESCE(u.picture_url, '') AS principal_picture_url,
  cm.offset_utf16,
  cm.length_utf16,
  cm.label_text
FROM comment_mentions cm
LEFT JOIN users u
  ON cm.principal_type = 'user' AND cm.principal_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON cm.principal_type = 'service_account' AND cm.principal_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE cm.comment_id = ANY(@comment_ids::text[])
ORDER BY cm.comment_id, cm.offset_utf16, cm.principal_type, cm.principal_id;

-- name: GetMentionUser :one
SELECT id, email, name, picture_url
FROM users
WHERE id = $1
FOR KEY SHARE;

-- name: GetMentionServiceAccount :one
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
SELECT id, name
FROM service_accounts -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE id = $1
FOR KEY SHARE;

-- name: UpdateCommentBody :exec
UPDATE comments SET body=$1 WHERE id=$2;

-- name: UpdateCommentStatus :exec
UPDATE comments SET status=$1, resolved_at=CASE WHEN $1='resolved' THEN now() ELSE NULL END WHERE id=$2;

-- name: DeleteComment :exec
DELETE FROM comments WHERE id=$1;

-- name: GetComment :one
SELECT id, document_id, created_on_version_id, author_type, author_id, author_email, author_name, body, selected_text, anchor_json, status, parent_comment_id, root_comment_id, created_at, resolved_at, edited_at
FROM comments
WHERE id = $1;

-- name: GetCommentForReply :one
SELECT id, document_id, created_on_version_id, author_type, author_id, author_email, author_name, body, selected_text, anchor_json, status, parent_comment_id, root_comment_id, created_at, resolved_at, edited_at
FROM comments
WHERE id = $1
FOR KEY SHARE;

-- name: GetCommentForUpdate :one
SELECT id, document_id, created_on_version_id, author_type, author_id, author_email, author_name, body, selected_text, anchor_json, status, parent_comment_id, root_comment_id, created_at, resolved_at, edited_at
FROM comments
WHERE id = $1
FOR UPDATE;

-- name: MarkCommentEdited :exec
UPDATE comments SET edited_at=clock_timestamp(), edit_revision=edit_revision+1 WHERE id=$1;
