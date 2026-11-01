-- name: LockDocumentForShare :one
-- The share lock makes an approval change wait for a version push in progress
-- (which holds the row for update), so a decision or an assignment never races
-- a new version. Read the version in a later statement: this statement's
-- snapshot cannot see a version that a push committed while it waited.
SELECT current_version_id FROM documents WHERE id = @document_id FOR SHARE;

-- name: CreatedVersionOf :one
-- Anyone who created a version of a document wrote what is under review.
SELECT EXISTS(
  SELECT 1 FROM versions
  WHERE document_id = @document_id
    AND created_by_type = @principal_type
    AND created_by_id = @principal_id
);

-- name: InsertApprovalRequest :exec
INSERT INTO approval_requests(id, document_id, approver_type, approver_id, requested_by_type, requested_by_id)
VALUES(@id, @document_id, @approver_type, @approver_id, @requested_by_type, @requested_by_id);

-- name: ListApprovalRequests :many
SELECT
  r.id,
  r.document_id,
  r.approver_type,
  r.approver_id,
  COALESCE(u.email, '') AS approver_email,
  COALESCE(u.name, sa.name, '') AS approver_name,
  COALESCE(u.picture_url, '') AS approver_picture_url,
  r.requested_by_type,
  r.requested_by_id,
  COALESCE(au.email, '') AS requested_by_email,
  COALESCE(au.name, asa.name, '') AS requested_by_name
FROM approval_requests r
LEFT JOIN users u
  ON r.approver_type = 'user' AND r.approver_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON r.approver_type = 'service_account' AND r.approver_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN users au
  ON r.requested_by_type = 'user' AND r.requested_by_id = au.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts asa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON r.requested_by_type = 'service_account' AND r.requested_by_id = asa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE r.document_id = @document_id AND r.revoked_at IS NULL
ORDER BY r.created_at, r.id;

-- name: HasActiveApprovalRequest :one
SELECT EXISTS(
  SELECT 1 FROM approval_requests
  WHERE document_id = @document_id
    AND approver_type = @approver_type
    AND approver_id = @approver_id
    AND revoked_at IS NULL
);

-- name: RevokeApprovalRequest :one
UPDATE approval_requests SET revoked_at = now()
WHERE id = @request_id AND document_id = @document_id AND revoked_at IS NULL
RETURNING approver_type, approver_id;

-- name: RevokeApproverRequest :execrows
UPDATE approval_requests SET revoked_at = now()
WHERE document_id = @document_id
  AND approver_type = @approver_type
  AND approver_id = @approver_id
  AND revoked_at IS NULL;

-- name: RevokeApprovalsForApprover :exec
UPDATE approvals SET revoked_at = now()
WHERE document_id = @document_id
  AND approver_type = @approver_type
  AND approver_id = @approver_id
  AND revoked_at IS NULL;

-- name: UpsertApproval :one
INSERT INTO approvals(id, document_id, version_id, sha256, approver_type, approver_id, decision, note)
VALUES(@id, @document_id, @version_id, @sha256, @approver_type, @approver_id, @decision, @note)
ON CONFLICT (document_id, sha256, approver_type, approver_id) WHERE revoked_at IS NULL
DO UPDATE SET version_id = EXCLUDED.version_id, decision = EXCLUDED.decision, note = EXCLUDED.note, decided_at = now()
RETURNING id, decided_at, (xmax = 0)::bool AS inserted;

-- name: ListContentApprovals :many
-- Active decisions on the given content, each with the version it was made on.
SELECT
  a.id,
  a.version_id,
  v.number AS version_number,
  a.sha256,
  a.approver_type,
  a.approver_id,
  COALESCE(u.email, '') AS approver_email,
  COALESCE(u.name, sa.name, '') AS approver_name,
  COALESCE(u.picture_url, '') AS approver_picture_url,
  a.decision,
  a.note,
  a.decided_at
FROM approvals a
JOIN versions v ON v.id = a.version_id
LEFT JOIN users u
  ON a.approver_type = 'user' AND a.approver_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON a.approver_type = 'service_account' AND a.approver_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE a.document_id = @document_id AND a.sha256 = @sha256 AND a.revoked_at IS NULL
ORDER BY a.decided_at, a.id;

-- name: GetApproval :one
SELECT id, document_id, version_id, approver_type, approver_id, decision
FROM approvals
WHERE id = @id AND document_id = @document_id AND revoked_at IS NULL;

-- name: RevokeApproval :execrows
UPDATE approvals SET revoked_at = now() WHERE id = @id AND revoked_at IS NULL;

-- name: DocumentApprovalSummaries :many
-- Per-document decision counts on the content of the document's current
-- version, counting only decisions from currently assigned approvers.
SELECT
  r.document_id,
  count(*) AS total,
  count(a.id) FILTER (WHERE a.decision = 'approved') AS approved,
  count(a.id) FILTER (WHERE a.decision = 'rejected') AS rejected
FROM approval_requests r
JOIN documents d ON d.id = r.document_id
JOIN versions cv ON cv.id = d.current_version_id
LEFT JOIN approvals a
  ON a.document_id = r.document_id
 AND a.sha256 = cv.sha256
 AND a.revoked_at IS NULL
 AND a.approver_type = r.approver_type
 AND a.approver_id = r.approver_id
WHERE r.document_id = ANY(@document_ids::text[]) AND r.revoked_at IS NULL
GROUP BY r.document_id;

-- name: InsertApprovalEvent :exec
-- A webhook event about a change to a document's approvals, written in the
-- transaction of the change. It names who and what at the time of the change,
-- so a receiver can act on it without reading the API.
INSERT INTO approval_event_outbox(id, payload)
SELECT @id::text, jsonb_strip_nulls(jsonb_build_object(
  'id', @id::text,
  'type', @event_type::text,
  'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'document', jsonb_build_object('id', d.id, 'title', d.title, 'url', @document_url::text),
  'version', jsonb_build_object('id', v.id, 'number', v.number, 'sha256', v.sha256),
  'approver', CASE WHEN @approver_id::text <> '' THEN jsonb_build_object(
    'type', @approver_type::text, 'id', @approver_id::text, 'email', ap.email, 'name', COALESCE(ap.name, aps.name)) END,
  'actor', jsonb_build_object(
    'type', @actor_type::text, 'id', @actor_id::text, 'email', ac.email, 'name', COALESCE(ac.name, acs.name)),
  'note', NULLIF(@note::text, ''),
  'status', NULLIF(@status::text, ''),
  'summary', @summary::jsonb
))
FROM documents d
JOIN versions v ON v.id = d.current_version_id
LEFT JOIN users ap
  ON @approver_type::text = 'user' AND ap.id = @approver_id::text
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts aps -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON @approver_type::text = 'service_account' AND aps.id = @approver_id::text -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN users ac
  ON @actor_type::text = 'user' AND ac.id = @actor_id::text
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts acs -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON @actor_type::text = 'service_account' AND acs.id = @actor_id::text -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE d.id = @document_id;
