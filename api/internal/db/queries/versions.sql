-- name: InsertInitialVersion :one
INSERT INTO versions(id,document_id,number,html_blob_key,sha256,parent_version_id,created_by_type,created_by_id,change_summary,search_text)
VALUES($1,$2,1,$3,$4,NULL,$5,$6,'',sqlc.arg(search_text)::text)
RETURNING created_at;

-- name: InsertVersion :one
INSERT INTO versions(id,document_id,number,html_blob_key,sha256,parent_version_id,created_by_type,created_by_id,change_summary,search_text)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,sqlc.arg(search_text)::text)
RETURNING created_at;

-- name: ListUnindexedVersions :many
-- Locks the rows, so that servers that index at the same time skip each
-- other's versions. Only current versions are searched. The documents are
-- locked too, because the search text changes their search_vector. Without
-- that lock, a delete that holds the document and waits for its version
-- causes a deadlock.
SELECT v.id, v.html_blob_key
FROM versions v
JOIN documents d ON d.current_version_id = v.id
WHERE v.search_text IS NULL AND v.id <> ALL(COALESCE(@skipped::text[], '{}'))
ORDER BY v.id
LIMIT @row_limit
FOR NO KEY UPDATE OF d SKIP LOCKED
FOR UPDATE OF v SKIP LOCKED;

-- name: SetVersionSearchText :exec
UPDATE versions SET search_text = @search_text::text WHERE id = @id;

-- name: ListVersions :many
SELECT
  v.id,
  v.number,
  v.document_id,
  v.created_by_type,
  v.created_by_id,
  COALESCE(u.email, '') AS created_by_email,
  COALESCE(u.name, sa.name, '') AS created_by_name,
  COALESCE(u.picture_url, '') AS created_by_picture_url,
  v.change_summary,
  v.sha256,
  v.created_at
FROM versions v
LEFT JOIN users u
  ON v.created_by_type = 'user' AND v.created_by_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON v.created_by_type = 'service_account' AND v.created_by_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE v.document_id=$1
ORDER BY v.number;

-- name: GetVersion :one
SELECT
  v.id,
  v.number,
  v.document_id,
  v.created_by_type,
  v.created_by_id,
  COALESCE(u.email, '') AS created_by_email,
  COALESCE(u.name, sa.name, '') AS created_by_name,
  COALESCE(u.picture_url, '') AS created_by_picture_url,
  v.change_summary,
  v.sha256,
  v.created_at
FROM versions v
LEFT JOIN users u
  ON v.created_by_type = 'user' AND v.created_by_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON v.created_by_type = 'service_account' AND v.created_by_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE v.id=$1;

-- name: GetVersionBlobKey :one
SELECT html_blob_key FROM versions WHERE id=$1;
