-- name: QueueBlobDeletion :exec
-- The transaction that deletes a document puts it in the list. So a server
-- that stops after the delete does not lose the blobs of the document.
INSERT INTO blob_deletions(document_id) VALUES (@document_id)
ON CONFLICT (document_id) DO NOTHING;

-- name: ClaimBlobDeletion :one
-- A document whose blobs can go: its retention period passed, and no server
-- has it. The lease moves available_at forward, so that another server takes
-- the document only when this one did not finish. attempts names the claim:
-- a server that was too slow does not change the row of the next one.
--
-- The choice of the document is a value in WHERE, which the database works
-- out once. As a table in FROM it is joined to the list, and the plan for an
-- empty list, which the list mostly is, ran it again for each row: each run
-- passed over the row that the statement had changed and gave the next one,
-- so one claim took every waiting document and the caller had the first.
UPDATE blob_deletions b
SET available_at = now() + make_interval(secs => @lease_seconds), attempts = b.attempts + 1
WHERE b.document_id = (
  SELECT document_id FROM blob_deletions
  WHERE available_at <= now() AND queued_at <= now() - make_interval(secs => @retention_seconds)
  ORDER BY queued_at, document_id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING b.document_id, b.attempts;

-- name: FinishBlobDeletion :exec
DELETE FROM blob_deletions WHERE document_id = @document_id AND attempts = @attempts;

-- name: RetryBlobDeletion :exec
UPDATE blob_deletions SET available_at = now() + make_interval(secs => @retry_seconds)
WHERE document_id = @document_id AND attempts = @attempts;

-- name: BlobDeletionBacklog :one
SELECT count(*)::bigint AS documents,
       COALESCE(EXTRACT(EPOCH FROM now() - min(queued_at)), 0)::float8 AS oldest_seconds
FROM blob_deletions;
