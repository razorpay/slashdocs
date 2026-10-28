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
-- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type, not a Google credential.
  ON r.approver_type = 'service_account' AND r.approver_id = sa.id -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
LEFT JOIN users au
  ON r.requested_by_type = 'user' AND r.requested_by_id = au.id
-- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts asa -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type, not a Google credential.
  ON r.requested_by_type = 'service_account' AND r.requested_by_id = asa.id -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
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

-- name: RevokeApprovalsForApprover :exec
UPDATE approvals SET revoked_at = now()
WHERE document_id = @document_id
  AND approver_type = @approver_type
  AND approver_id = @approver_id
  AND revoked_at IS NULL;

-- name: UpsertApproval :one
INSERT INTO approvals(id, document_id, version_id, approver_type, approver_id, decision, note)
VALUES(@id, @document_id, @version_id, @approver_type, @approver_id, @decision, @note)
ON CONFLICT (version_id, approver_type, approver_id) WHERE revoked_at IS NULL
DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, decided_at = now(), carried_from_version_id = NULL
RETURNING id, decided_at, (xmax = 0)::bool AS inserted;

-- name: ListVersionApprovals :many
SELECT
  a.id,
  a.version_id,
  a.approver_type,
  a.approver_id,
  COALESCE(u.email, '') AS approver_email,
  COALESCE(u.name, sa.name, '') AS approver_name,
  COALESCE(u.picture_url, '') AS approver_picture_url,
  a.decision,
  a.note,
  a.decided_at,
  COALESCE(a.carried_from_version_id, '') AS carried_from_version_id
FROM approvals a
LEFT JOIN users u
  ON a.approver_type = 'user' AND a.approver_id = u.id
-- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type, not a Google credential.
  ON a.approver_type = 'service_account' AND a.approver_id = sa.id -- nosemgrep: detected-google-gcm-service-account - aidocs-native principal type/table, not a Google credential.
WHERE a.document_id = @document_id AND a.version_id = @version_id AND a.revoked_at IS NULL
ORDER BY a.decided_at, a.id;

-- name: GetApproval :one
SELECT id, document_id, version_id, approver_type, approver_id, decision
FROM approvals
WHERE id = @id AND document_id = @document_id AND revoked_at IS NULL;

-- name: RevokeApproval :execrows
UPDATE approvals SET revoked_at = now() WHERE id = @id AND revoked_at IS NULL;

-- name: ListCarryForwardApprovals :many
-- Active approved decisions on a version, with the origin version that
-- received the explicit decision (so provenance survives chained pushes).
SELECT approver_type, approver_id, decided_at, note,
       COALESCE(carried_from_version_id, version_id) AS origin_version_id
FROM approvals
WHERE document_id = @document_id
  AND version_id = @version_id
  AND decision = 'approved'
  AND revoked_at IS NULL;

-- name: InsertCarriedApproval :exec
INSERT INTO approvals(id, document_id, version_id, approver_type, approver_id, decision, note, decided_at, carried_from_version_id)
VALUES(@id, @document_id, @version_id, @approver_type, @approver_id, 'approved', @note, @decided_at, @carried_from_version_id);

-- name: DocumentApprovalSummaries :many
-- Per-document decision counts for the document's current version, counting
-- only decisions from currently assigned approvers.
SELECT
  r.document_id,
  count(*) AS total,
  count(a.id) FILTER (WHERE a.decision = 'approved') AS approved,
  count(a.id) FILTER (WHERE a.decision = 'changes_requested') AS changes_requested
FROM approval_requests r
JOIN documents d ON d.id = r.document_id
LEFT JOIN approvals a
  ON a.version_id = d.current_version_id
 AND a.revoked_at IS NULL
 AND a.approver_type = r.approver_type
 AND a.approver_id = r.approver_id
WHERE r.document_id = ANY(@document_ids::text[]) AND r.revoked_at IS NULL
GROUP BY r.document_id;

-- name: InsertApprovalEvent :exec
INSERT INTO approval_events(document_id, event_type)
VALUES(@document_id, @event_type);

-- name: InsertApprovalEventIfApprovers :exec
-- A new version only matters to a document that has approvers: without them it
-- has no approval state to reset or carry.
INSERT INTO approval_events(document_id, event_type)
SELECT @document_id::text, @event_type::text
WHERE EXISTS (
  SELECT 1 FROM approval_requests
  WHERE document_id = @document_id::text AND revoked_at IS NULL
);

-- name: PruneApprovalEvents :exec
DELETE FROM approval_events WHERE created_at < now() - interval '90 days';

-- name: ListApprovalEvents :many
-- Events after a cursor, oldest first: the feed a reader pages through.
SELECT id, document_id, event_type, created_at
FROM approval_events
WHERE id > @after_id
ORDER BY id
LIMIT @max_rows;
