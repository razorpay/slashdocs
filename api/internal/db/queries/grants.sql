-- name: UpsertResourceGrant :one
-- A revoked grant for the same (resource, principal) is resurrected by the
-- conflict clause, keeping its ORIGINAL id; return the persisted id so
-- callers never hand out an id that was never written.
INSERT INTO resource_grants(id,resource_type,resource_id,principal_type,principal_id,role,granted_by_type,granted_by_user_id)
VALUES(@id,@resource_type,@resource_id,@principal_type,@principal_id,@role,@granted_by_type,@granted_by_user_id)
ON CONFLICT(resource_type,resource_id,principal_type,principal_id) DO UPDATE SET role=EXCLUDED.role, revoked_at=NULL, granted_by_type=EXCLUDED.granted_by_type, granted_by_user_id=EXCLUDED.granted_by_user_id
RETURNING id;

-- name: ListResourceGrants :many
SELECT
  g.id,
  g.resource_type,
  g.resource_id,
  g.principal_type,
  g.principal_id,
  COALESCE(u.email, gg.email, '') AS principal_email,
  COALESCE(u.name, sa.name, gg.display_name, '') AS principal_name,
  COALESCE(u.picture_url, '') AS principal_picture_url,
  g.role,
  g.granted_by_type,
  g.granted_by_user_id,
  COALESCE(gu.email, '') AS granted_by_email,
  COALESCE(gu.name, gsa.name, '') AS granted_by_name
FROM resource_grants g
LEFT JOIN users u
  ON g.principal_type = 'user' AND g.principal_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON g.principal_type = 'service_account' AND g.principal_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN google_groups gg
  ON g.principal_type = 'google_group' AND g.principal_id = gg.id
LEFT JOIN users gu
  ON g.granted_by_type = 'user' AND g.granted_by_user_id = gu.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts gsa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON g.granted_by_type = 'service_account' AND g.granted_by_user_id = gsa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE g.resource_id= @resource_id AND g.revoked_at IS NULL;

-- name: UpdateResourceGrantRole :one
UPDATE resource_grants SET role= @role
WHERE id= @grant_id AND resource_id= @resource_id AND revoked_at IS NULL
RETURNING id, resource_type, resource_id, principal_type, principal_id, role, granted_by_type, granted_by_user_id;

-- name: RevokeResourceGrant :execrows
UPDATE resource_grants SET revoked_at=now() WHERE id= @grant_id AND resource_id= @resource_id AND revoked_at IS NULL;

-- name: ListDocumentInheritedGrants :many
-- All active grants on a document and on every folder above it. The caller
-- folds these (plus ownership) into the principal's effective role.
WITH RECURSIVE ancestors(rid, rtype, depth) AS (
  SELECT @document_id::text, 'document'::text, 0
  UNION ALL
  SELECT f.id, 'folder'::text, a.depth+1
  FROM ancestors a
  JOIN LATERAL (
    SELECT CASE WHEN a.rtype='document' THEN (SELECT parent_folder_id FROM documents WHERE id=a.rid)
                ELSE (SELECT parent_folder_id FROM folders WHERE id=a.rid) END AS pid
  ) sub ON true
  JOIN folders f ON f.id = sub.pid
  WHERE sub.pid IS NOT NULL AND a.depth < 64
)
SELECT g.resource_id, g.principal_type, g.principal_id, g.role
FROM resource_grants g
WHERE g.revoked_at IS NULL
  AND g.resource_id IN (SELECT rid FROM ancestors);

-- name: ListResourceAncestors :many
-- The resource itself plus every folder above it, with titles and owners, for
-- the effective-access report.
WITH RECURSIVE ancestors(rid, rtype, depth) AS (
  SELECT @resource_id::text, @resource_type::text, 0
  UNION ALL
  SELECT CASE WHEN a.rtype='document' THEN (SELECT parent_folder_id FROM documents WHERE id=a.rid)
              ELSE (SELECT parent_folder_id FROM folders WHERE id=a.rid) END,
         'folder', a.depth+1
  FROM ancestors a WHERE a.depth < 64
)
SELECT a.rid::text AS ancestor_id, a.rtype::text AS ancestor_type,
       COALESCE(f.title, d.title, '') AS title,
       COALESCE(f.owner_type, d.owner_type, '') AS owner_type,
       COALESCE(f.owner_id, d.owner_id, '') AS owner_id,
       COALESCE(ou.email, '') AS owner_email,
       COALESCE(ou.name, osa.name, '') AS owner_name,
       COALESCE(ou.picture_url, '') AS owner_picture_url
FROM ancestors a
LEFT JOIN folders f ON a.rtype='folder' AND f.id=a.rid
LEFT JOIN documents d ON a.rtype='document' AND d.id=a.rid
LEFT JOIN users ou
  ON COALESCE(f.owner_type, d.owner_type)='user'
 AND COALESCE(f.owner_id, d.owner_id)=ou.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts osa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON COALESCE(f.owner_type, d.owner_type)='service_account'
 AND COALESCE(f.owner_id, d.owner_id)=osa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE a.rid IS NOT NULL;

-- name: ListGrantsForResources :many
SELECT g.id, g.resource_id, g.resource_type, g.principal_type, g.principal_id,
       COALESCE(u.email,gg.email,'') AS principal_email,
       COALESCE(u.name,sa.name,gg.display_name,'') AS principal_name, g.role
FROM resource_grants g
LEFT JOIN users u ON g.principal_type='user' AND g.principal_id=u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON g.principal_type='service_account' AND g.principal_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN google_groups gg ON g.principal_type='google_group' AND g.principal_id=gg.id
WHERE g.revoked_at IS NULL AND g.resource_id = ANY(@resource_ids::text[]);
