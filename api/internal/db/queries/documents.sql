-- name: GetDocumentOwner :one
SELECT owner_type, owner_id FROM documents WHERE id=$1;

-- name: InsertDocument :exec
INSERT INTO documents(id,title,owner_type,owner_id) VALUES($1,$2,$3,$4);

-- name: UpdateDocumentCurrentVersion :exec
UPDATE documents SET current_version_id=$1, updated_at=now() WHERE id=$2;

-- name: GetDocument :one
SELECT d.id,d.title,d.current_version_id,d.owner_type,d.owner_id,
       COALESCE(u.email,'') AS owner_email,
       COALESCE(u.name,sa.name,'') AS owner_name,
       COALESCE(d.parent_folder_id,'') AS parent_folder_id
FROM documents d
LEFT JOIN users u ON d.owner_type='user' AND u.id=d.owner_id
-- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type, not a Google credential.
  ON d.owner_type='service_account' AND sa.id=d.owner_id -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
WHERE d.id=$1;

-- name: GetDocumentVersionForUpdate :one
SELECT current_version_id, COALESCE((SELECT max(number)+1 FROM versions WHERE document_id=$1),1)::int AS next_number
FROM documents WHERE id=$1 FOR UPDATE;

-- name: RecordWorkspaceEntry :exec
-- Records that a principal has opened a document, so a broadly-shared ("anyone")
-- document joins their workspace listing after first open. Idempotent.
INSERT INTO document_workspace_entries(document_id,principal_type,principal_id)
VALUES($1,$2,$3)
ON CONFLICT(document_id,principal_type,principal_id) DO NOTHING;

-- name: ListDocuments :many
-- A document appears in a principal's workspace when they:
--   1. own it, or
--   2. hold an explicit (user/service-account) grant for it, or
--   3. have opened it (a workspace entry exists) AND it is still broadly shared
--      via an active "anyone" grant.
-- A bare "anyone" grant alone does NOT list the document: broad access grants
-- access via discovery/link, it does not place the document in every user's
-- workspace until they open it.
SELECT d.id,d.title,d.current_version_id,d.owner_type,d.owner_id,
       COALESCE(u.email,'') AS owner_email,
       COALESCE(u.name,sa.name,'') AS owner_name,
       d.updated_at
FROM documents d
LEFT JOIN users u ON d.owner_type='user' AND u.id=d.owner_id
-- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type, not a Google credential.
  ON d.owner_type='service_account' AND sa.id=d.owner_id -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
WHERE d.parent_folder_id IS NULL
  AND (
   (d.owner_type=$2 AND d.owner_id=$1)
   OR EXISTS (
       SELECT 1 FROM resource_grants g
       WHERE g.resource_type='document'
         AND g.resource_id=d.id
         AND g.revoked_at IS NULL
	 AND ((g.principal_type=$2 AND g.principal_id=$1)
	      OR (g.principal_type='google_group' AND g.principal_id=ANY($3::text[])))
   )
   OR (
       EXISTS (
           SELECT 1 FROM document_workspace_entries w
           WHERE w.document_id=d.id
             AND w.principal_type=$2 AND w.principal_id=$1
       )
       AND EXISTS (
           SELECT 1 FROM resource_grants g
           WHERE g.resource_type='document'
             AND g.resource_id=d.id
             AND g.revoked_at IS NULL
             AND g.principal_type='anyone'
       )
   )
  )
ORDER BY d.updated_at DESC
LIMIT 25;

-- name: UpdateDocumentTitle :exec
UPDATE documents SET title=$1,updated_at=now() WHERE id=$2;

-- name: SearchDocuments :many
WITH RECURSIVE folder_ancestors(doc_id, fid, depth) AS (
  SELECT d2.id, d2.parent_folder_id, 1
  FROM documents d2
  WHERE d2.parent_folder_id IS NOT NULL
  UNION ALL
  SELECT fa.doc_id, f.parent_folder_id, fa.depth+1
  FROM folders f JOIN folder_ancestors fa ON f.id=fa.fid
  WHERE f.parent_folder_id IS NOT NULL AND fa.depth < 20
),
docs_via_folder AS (
  SELECT DISTINCT fa.doc_id
  FROM folder_ancestors fa
  JOIN resource_grants g ON g.resource_type='folder' AND g.resource_id=fa.fid AND g.revoked_at IS NULL
  WHERE (g.principal_type= @owner_type AND g.principal_id= @owner_id)
     OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
     OR (@include_org_wide::boolean AND g.principal_type='anyone')
)
SELECT DISTINCT d.id,d.title,d.current_version_id,d.owner_type,d.owner_id,
       COALESCE(u.email,'') AS owner_email,
       COALESCE(u.name,sa.name,'') AS owner_name,
       d.updated_at
FROM documents d
LEFT JOIN users u ON d.owner_type='user' AND u.id=d.owner_id
LEFT JOIN service_accounts sa
  ON d.owner_type='service_account' AND sa.id=d.owner_id
WHERE (@title_pattern::text = '' OR d.title ~* @title_pattern::text)
  AND (
    @author_pattern::text = ''
    OR COALESCE(NULLIF(u.email,''), NULLIF(sa.name,''), d.owner_id) ~* @author_pattern::text
  )
  AND (
    @folder_pattern::text = ''
    OR EXISTS (
      SELECT 1
      FROM folder_ancestors search_folder_ancestor
      JOIN folders search_folder ON search_folder.id=search_folder_ancestor.fid
      WHERE search_folder_ancestor.doc_id=d.id
        AND search_folder.title ~* @folder_pattern::text
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM unnest(@label_patterns::text[]) AS requested_label(pattern)
    WHERE NOT EXISTS (
      SELECT 1 FROM document_labels dl
      WHERE dl.document_id=d.id AND dl.label ~* requested_label.pattern
    )
  )
  AND (
    (d.owner_type= @owner_type AND d.owner_id= @owner_id)
    OR EXISTS (
      SELECT 1 FROM resource_grants g
      WHERE g.resource_type='document'
        AND g.resource_id=d.id
        AND g.revoked_at IS NULL
        AND ((g.principal_type= @owner_type AND g.principal_id= @owner_id)
          OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
          OR (@include_org_wide::boolean AND g.principal_type='anyone'))
    )
    OR d.id IN (SELECT doc_id FROM docs_via_folder)
  )
ORDER BY d.updated_at DESC, d.title
LIMIT @row_limit OFFSET @row_offset;

-- name: DeleteDocument :execrows
DELETE FROM documents WHERE id=$1;

-- name: MoveDocumentToFolder :execrows
UPDATE documents SET parent_folder_id= @folder_id::text, updated_at=now() WHERE id= @document_id;

-- name: MoveDocumentToRoot :exec
UPDATE documents SET parent_folder_id=NULL, updated_at=now() WHERE id= @document_id AND parent_folder_id= @folder_id::text;

-- name: ListFolderDocuments :many
SELECT d.id, d.title, d.owner_type, d.owner_id,
       COALESCE(d.current_version_id,'') AS current_version_id,
       COALESCE(d.parent_folder_id,'') AS parent_folder_id,
       COALESCE(u.name,sa.name,'') AS owner_name,
       COALESCE(u.email,'') AS owner_email
FROM documents d
LEFT JOIN users u ON d.owner_type='user' AND d.owner_id=u.id
-- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type, not a Google credential.
  ON d.owner_type='service_account' AND d.owner_id=sa.id -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
WHERE d.parent_folder_id= @folder_id::text;
