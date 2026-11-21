-- name: LockDocumentForKV :one
-- Serializes revision allocation. NO KEY UPDATE still excludes every other
-- allocator but, unlike FOR UPDATE, does not wait on foreign-key checks from
-- concurrent comment and version writes.
SELECT id FROM documents WHERE id=$1 FOR NO KEY UPDATE;

-- name: ListDocumentKV :many
SELECT key,value,revision,updated_at,updated_by_type,updated_by_id,updated_by_email,updated_by_name
FROM document_kv
WHERE document_id=$1 AND deleted_at IS NULL
ORDER BY key;


-- name: GetDocumentKVRevision :one
SELECT kv_revision
FROM documents
WHERE id = $1;

-- name: IncrementDocumentKVRevision :one
UPDATE documents
SET kv_revision = kv_revision + 1
WHERE id = $1
RETURNING kv_revision;

-- name: InsertDocumentKVEvent :exec
INSERT INTO document_kv_events(document_id,revision,kind,changes,data,updated_by_type,updated_by_id,updated_by_email,updated_by_name)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9);

-- name: NotifyDocumentKVEvent :exec
SELECT pg_notify('slashdocs_kv_events', sqlc.arg(document_id)::text);

-- name: ListDocumentKVEventsAfter :many
SELECT document_id,revision,changes,updated_at,updated_by_type,updated_by_id,updated_by_email,updated_by_name,kind,data
FROM document_kv_events
WHERE document_id=$1 AND revision>$2
ORDER BY revision
LIMIT $3;

-- name: UpsertDocumentKV :exec
INSERT INTO document_kv(document_id,key,value,revision,updated_by_type,updated_by_id,updated_by_email,updated_by_name,deleted_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)
ON CONFLICT(document_id,key) DO UPDATE
SET value=EXCLUDED.value,
    revision=EXCLUDED.revision,
    updated_at=now(),
    updated_by_type=EXCLUDED.updated_by_type,
    updated_by_id=EXCLUDED.updated_by_id,
    updated_by_email=EXCLUDED.updated_by_email,
    updated_by_name=EXCLUDED.updated_by_name,
    deleted_at=NULL;

-- name: DeleteDocumentKV :exec
INSERT INTO document_kv(document_id,key,value,revision,updated_by_type,updated_by_id,updated_by_email,updated_by_name,deleted_at)
VALUES($1,$2,'null'::jsonb,$3,$4,$5,$6,$7,now())
ON CONFLICT(document_id,key) DO UPDATE
SET value='null'::jsonb,
    revision=EXCLUDED.revision,
    updated_at=now(),
    updated_by_type=EXCLUDED.updated_by_type,
    updated_by_id=EXCLUDED.updated_by_id,
    updated_by_email=EXCLUDED.updated_by_email,
    updated_by_name=EXCLUDED.updated_by_name,
    deleted_at=now();

-- name: ListRecentDocumentPresenceEvents :many
SELECT document_id,revision,changes,updated_at,updated_by_type,updated_by_id,updated_by_email,updated_by_name,kind,data
FROM document_kv_events
WHERE document_id=$1 AND kind='presence' AND updated_at > now() - make_interval(secs => sqlc.arg(max_age_seconds)::int)
ORDER BY revision;

-- name: DeleteStaleDocumentPresenceEvents :exec
DELETE FROM document_kv_events
WHERE document_id=$1 AND kind='presence' AND updated_at < now() - make_interval(secs => sqlc.arg(max_age_seconds)::int);
