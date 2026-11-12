-- name: ListDocumentLabels :many
SELECT label FROM document_labels WHERE document_id=$1 ORDER BY label;

-- name: DeleteDocumentLabels :exec
DELETE FROM document_labels WHERE document_id=$1;

-- name: InsertDocumentLabel :exec
INSERT INTO document_labels(document_id,label,created_by_type,created_by_id)
VALUES($1,$2,$3,$4);

-- name: ListAccessibleDocumentsByLabel :many
SELECT DISTINCT d.id,d.title,d.current_version_id,d.owner_type,d.owner_id,
       COALESCE(u.email,'') AS owner_email,
       COALESCE(u.name,sa.name,'') AS owner_name,
       d.updated_at
FROM documents d
JOIN document_labels dl ON dl.document_id=d.id AND dl.label=sqlc.arg(label)::text
LEFT JOIN users u ON d.owner_type='user' AND u.id=d.owner_id
LEFT JOIN service_accounts sa ON d.owner_type='service_account' AND sa.id=d.owner_id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE d.parent_folder_id IS NULL AND (
  (d.owner_type=sqlc.arg(owner_type)::text AND d.owner_id=sqlc.arg(owner_id)::text)
  OR EXISTS (
    SELECT 1 FROM resource_grants g
    WHERE g.resource_type='document' AND g.resource_id=d.id
      AND g.revoked_at IS NULL
      AND ((g.principal_type=sqlc.arg(owner_type)::text AND g.principal_id=sqlc.arg(owner_id)::text)
        OR (g.principal_type='google_group' AND g.principal_id=ANY(sqlc.arg(google_group_ids)::text[]))
        OR g.principal_type='anyone')
  )
)
ORDER BY d.updated_at DESC
LIMIT 25;
