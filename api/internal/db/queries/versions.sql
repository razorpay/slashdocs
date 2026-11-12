-- name: InsertInitialVersion :one
-- The first version of a document is sealed at seq 1.
INSERT INTO versions(id,document_id,number,html_blob_key,sha256,parent_version_id,created_by_type,created_by_id,change_summary,search_text,seq)
VALUES($1,$2,1,$3,$4,NULL,$5,$6,'',sqlc.arg(search_text)::text,1)
RETURNING created_at;

-- name: InsertOpenVersion :exec
-- The blob of an open version is a snapshot of the live document at its
-- seq, and the operations after that seq complete it. The version keeps the
-- search text of the version before until it is sealed, so that search finds
-- the document all the time.
INSERT INTO versions(id,document_id,number,html_blob_key,sha256,parent_version_id,created_by_type,created_by_id,search_text,seq,sealed_at)
SELECT @id, p.document_id, p.number + 1, p.html_blob_key, '', p.id, @created_by_type, @created_by_id, p.search_text, @seq, NULL
FROM versions p WHERE p.id = @parent_version_id;

-- name: ContinueSitting :exec
-- The version id, which people opened by typing, goes on with their sitting
-- when a write that is not typing cut that sitting: the version before it
-- holds no typing, and the version before that holds typing of the last
-- idle_seconds and no approval decision, which History keeps in its row.
UPDATE versions v SET sitting_id = COALESCE(a.sitting_id, a.id)
FROM versions p JOIN versions a ON a.id = p.parent_version_id
WHERE v.id = @id AND p.id = v.parent_version_id
  AND NOT EXISTS (SELECT 1 FROM document_ops o WHERE o.version_id = p.id AND o.typed)
  AND EXISTS (
    SELECT 1 FROM document_ops o
    WHERE o.version_id = a.id AND o.typed AND o.created_at > now() - make_interval(secs => @idle_seconds::float8)
  )
  AND NOT EXISTS (SELECT 1 FROM approvals ap WHERE ap.version_id = a.id);

-- name: SnapshotVersion :one
-- Moves the snapshot of an open version to a later seq, and returns the
-- blob key of the snapshot before. No row means that the version is sealed
-- or has a later snapshot.
UPDATE versions v SET html_blob_key = @html_blob_key, seq = @seq
WHERE v.id = @id AND v.sealed_at IS NULL AND v.seq < @seq
RETURNING (SELECT o.html_blob_key FROM versions o WHERE o.id = @id)::text AS replaced;

-- name: SealVersion :exec
UPDATE versions
SET html_blob_key = @html_blob_key, sha256 = @sha256, search_text = @search_text::text,
    change_summary = @change_summary, seq = @seq, sealed_at = now()
WHERE id = @id;

-- name: ListUnindexedVersions :many
-- Locks the rows, so that servers that index at the same time skip each
-- other's versions. Only current versions are searched. The documents are
-- locked too, because the search text changes their search_vector. Without
-- that lock, a delete that holds the document and waits for its version
-- causes a deadlock. An open version gets its text when it is sealed.
SELECT v.id, v.html_blob_key
FROM versions v
JOIN documents d ON d.current_version_id = v.id
WHERE v.search_text IS NULL AND v.sealed_at IS NOT NULL AND v.id <> ALL(COALESCE(@skipped::text[], '{}'))
ORDER BY v.id
LIMIT @row_limit
FOR NO KEY UPDATE OF d SKIP LOCKED
FOR UPDATE OF v SKIP LOCKED;

-- name: SetVersionSearchText :exec
UPDATE versions SET search_text = @search_text::text WHERE id = @id;

-- name: ListVersions :many
-- seq is the seq of the content of a version. For the current version it is
-- the seq of the live document. edited_at is the time of the last operation
-- of the version, or created_at when the log holds none. The operations
-- after the seq of a sealed version are of a sitting that changed nothing,
-- and are not edits of the version.
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
  v.created_at,
  (v.sealed_at IS NULL)::bool AS open,
  (CASE WHEN d.current_version_id = v.id THEN d.seq ELSE v.seq END)::bigint AS seq,
  COALESCE(v.sitting_id, '')::text AS sitting_id,
  COALESCE((
    SELECT o.created_at FROM document_ops o
    WHERE o.version_id = v.id AND (v.sealed_at IS NULL OR o.seq <= v.seq)
    ORDER BY o.seq DESC LIMIT 1
  ), v.created_at)::timestamptz AS edited_at
FROM versions v
JOIN documents d ON d.id = v.document_id
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
  v.created_at,
  (v.sealed_at IS NULL)::bool AS open,
  (CASE WHEN d.current_version_id = v.id THEN d.seq ELSE v.seq END)::bigint AS seq,
  COALESCE(v.sitting_id, '')::text AS sitting_id,
  COALESCE((
    SELECT o.created_at FROM document_ops o
    WHERE o.version_id = v.id AND (v.sealed_at IS NULL OR o.seq <= v.seq)
    ORDER BY o.seq DESC LIMIT 1
  ), v.created_at)::timestamptz AS edited_at
FROM versions v
JOIN documents d ON d.id = v.document_id
LEFT JOIN users u
  ON v.created_by_type = 'user' AND v.created_by_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON v.created_by_type = 'service_account' AND v.created_by_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE v.id=$1;

-- name: InsertVersionAuthor :exec
INSERT INTO version_authors(version_id, author_type, author_id)
VALUES($1, $2, $3) ON CONFLICT DO NOTHING;

-- name: ListVersionAuthors :many
-- The people whose operations each version of a document holds, or one
-- version when version_id is set. The first to write comes first.
SELECT
  w.version_id,
  w.author_type,
  w.author_id,
  COALESCE(u.email, '') AS author_email,
  COALESCE(u.name, sa.name, '') AS author_name,
  COALESCE(u.picture_url, '') AS author_picture_url
FROM version_authors w
JOIN versions v ON v.id = w.version_id
LEFT JOIN users u
  ON w.author_type = 'user' AND w.author_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON w.author_type = 'service_account' AND w.author_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE v.document_id = @document_id
  AND (sqlc.narg(version_id)::text IS NULL OR w.version_id = sqlc.narg(version_id))
ORDER BY w.created_at, w.author_id;

-- name: ListOperationAuthorsAfter :many
-- The authors of the operations of a document after one seq, up to another.
-- The author of the newest operation comes first. typed says that the
-- browser editor made each of the author's operations.
SELECT
  o.author_type,
  o.author_id,
  COALESCE(u.email, '') AS author_email,
  COALESCE(u.name, sa.name, '') AS author_name,
  COALESCE(u.picture_url, '') AS author_picture_url,
  bool_and(o.typed)::bool AS typed
FROM document_ops o
LEFT JOIN users u
  ON o.author_type = 'user' AND o.author_id = u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON o.author_type = 'service_account' AND o.author_id = sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE o.document_id = @document_id AND o.seq > @after_seq AND o.seq <= @to_seq
GROUP BY o.author_type, o.author_id, u.email, u.name, sa.name, u.picture_url
ORDER BY max(o.seq) DESC;

-- name: GetVersionPreview :one
-- The start of a version's text and when the version was created, for link
-- previews. The text is empty until the version is indexed.
SELECT left(COALESCE(search_text, ''), 2000)::text AS text, created_at
FROM versions WHERE id=$1;

-- name: GetLiveDocument :one
-- The current version of a document, as GetLiveVersion gives it, with no
-- lock. One statement reads the document and the version, so that they are
-- of one moment.
SELECT v.id, v.document_id, v.number, (v.sealed_at IS NULL)::bool AS open, v.seq, v.html_blob_key,
       COALESCE(v.parent_version_id, '')::text AS parent_version_id,
       COALESCE(v.sitting_id, '')::text AS sitting_id,
       COALESCE(p.html_blob_key, '')::text AS parent_blob_key,
       COALESCE(p.sha256, '')::text AS parent_sha256,
       COALESCE(p.seq, 0)::bigint AS parent_seq,
       v.created_by_type, v.created_by_id, v.created_at,
       d.seq AS document_seq, true::bool AS current
FROM documents d
JOIN versions v ON v.id = d.current_version_id
LEFT JOIN versions p ON p.id = v.parent_version_id
WHERE d.id = $1;

-- name: LockDocument :one
-- The writes to the live document and the approval writes on a document
-- take turns. So a decision or an assignment never races a new version, and
-- the status that each approval change records counts every change before
-- it. NO KEY UPDATE does not wait on foreign-key checks from concurrent
-- comment writes. Read the version in a later statement: the snapshot of
-- this statement cannot see a version that another write committed while it
-- waited for the lock.
SELECT COALESCE(current_version_id, '')::text AS current_version_id FROM documents WHERE id = $1 FOR NO KEY UPDATE;

-- name: GetLiveVersion :one
-- A version with where its content is, and the seq of the live document.
-- The blob of an open version is a snapshot at seq. The content of the
-- version before it is in parent_blob_key, and parent_seq is the seq of that
-- content: the version has no state before it. current says that it is the
-- current version of its document.
SELECT v.id, v.document_id, v.number, (v.sealed_at IS NULL)::bool AS open, v.seq, v.html_blob_key,
       COALESCE(v.parent_version_id, '')::text AS parent_version_id,
       COALESCE(v.sitting_id, '')::text AS sitting_id,
       COALESCE(p.html_blob_key, '')::text AS parent_blob_key,
       COALESCE(p.sha256, '')::text AS parent_sha256,
       COALESCE(p.seq, 0)::bigint AS parent_seq,
       v.created_by_type, v.created_by_id, v.created_at,
       d.seq AS document_seq, (d.current_version_id IS NOT DISTINCT FROM v.id)::bool AS current
FROM versions v
JOIN documents d ON d.id = v.document_id
LEFT JOIN versions p ON p.id = v.parent_version_id
WHERE v.id = $1;

-- name: SetDocumentSeq :exec
UPDATE documents SET seq = $1, updated_at = now() WHERE id = $2;

-- name: InsertOperation :exec
INSERT INTO document_ops(document_id,seq,version_id,author_type,author_id,client_op_id,typed,summary,replacements,sum)
VALUES(@document_id,@seq,@version_id,@author_type,@author_id,sqlc.narg(client_op_id),@typed,@summary,sqlc.narg(replacements),@sum);

-- name: GetOperationByClientID :one
-- held says that the log still holds the replacements of the operation.
SELECT seq, version_id, sum, (replacements IS NOT NULL)::bool AS held
FROM document_ops WHERE document_id = $1 AND client_op_id = $2;

-- name: ListOperations :many
-- The operations of a document after one seq, up to another, in order.
SELECT seq, version_id, replacements, sum FROM document_ops
WHERE document_id = @document_id AND seq > @after_seq AND seq <= @to_seq
ORDER BY seq;

-- name: ListVersionOperationSummaries :many
-- The summaries that the operations of a version carry, without repeats, in
-- the order of their first use, and not more than row_limit of them.
SELECT summary FROM document_ops
WHERE version_id = @version_id AND summary <> ''
GROUP BY summary ORDER BY min(seq)
LIMIT @row_limit;

-- name: HasRecentOperationOfAnother :one
-- Whether a person other than the author wrote an operation of the document
-- in the last seconds. idx_document_ops_recent gives only those operations.
SELECT EXISTS (
  SELECT 1 FROM document_ops
  WHERE document_id = @document_id AND created_at > now() - make_interval(secs => @seconds)
    AND (author_type <> @author_type OR author_id <> @author_id)
)::bool;

-- name: GetIdleVersion :one
-- A version that is ready to be sealed, with its document: the current
-- version of a document whose last operation is older than idle_seconds, or
-- an open version that is not the current one, which a server of the
-- release before can leave. It takes no lock: the caller locks the document
-- and makes sure that the version is still ready. skipped holds the
-- documents that the caller looked at already. The order makes one such
-- document not hide the others.
SELECT d.id AS document_id, v.id AS version_id, (d.current_version_id IS NOT DISTINCT FROM v.id)::bool AS current
FROM versions v
JOIN documents d ON d.id = v.document_id
WHERE v.sealed_at IS NULL AND d.id <> ALL(COALESCE(@skipped::text[], '{}'))
  AND (d.current_version_id IS DISTINCT FROM v.id OR NOT EXISTS (
    SELECT 1 FROM document_ops o
    WHERE o.document_id = d.id AND o.seq = d.seq AND o.created_at >= now() - make_interval(secs => @idle_seconds)))
ORDER BY d.id, v.id
LIMIT 1;

-- name: IsDocumentIdle :one
-- Whether the operation at seq, the last one of the document, is older than
-- idle_seconds.
SELECT (NOT EXISTS (
  SELECT 1 FROM document_ops
  WHERE document_id = @document_id AND seq = @seq AND created_at >= now() - make_interval(secs => @idle_seconds)
))::bool;

-- name: SealStrayVersion :exec
-- Seals an open version that is not the current one of its document. Its
-- blob, the last snapshot, is its content.
UPDATE versions SET sealed_at = now() WHERE id = $1 AND sealed_at IS NULL;

-- name: LockVersion :exec
-- Locks a version before DiscardOpenVersion deletes it. The lock waits for
-- the writes that refer to the version, such as a new comment on it, and
-- makes the later ones wait. So DiscardOpenVersion, which is a later
-- statement, sees each comment that refers to the version.
SELECT 1 FROM versions WHERE id = $1 FOR UPDATE;

-- name: KeyShareVersion :one
-- Returns the document of a version, and locks the version for a write that
-- refers to it, such as a new comment. DiscardOpenVersion, which locks the
-- version with LockVersion, then moves that write, or the write sees that
-- the version is gone.
SELECT document_id FROM versions WHERE id = $1 FOR KEY SHARE;

-- name: DiscardOpenVersion :exec
-- Removes an open version whose content is that of the version before, and
-- makes that version the current one again. Its operations stay in the log
-- as operations of the version before, for the pages that are behind. The
-- comments made on it stay too. Its authors go with it.
WITH ops AS (
  UPDATE document_ops SET version_id = @parent_version_id::text WHERE version_id = @id::text
), made AS (
  UPDATE comments SET created_on_version_id = @parent_version_id::text WHERE created_on_version_id = @id::text
), placed AS (
  UPDATE comment_placements c SET version_id = @parent_version_id::text
  WHERE c.version_id = @id::text AND NOT EXISTS (
    SELECT 1 FROM comment_placements o WHERE o.comment_id = c.comment_id AND o.version_id = @parent_version_id::text)
), moved AS (
  UPDATE documents SET current_version_id = @parent_version_id::text WHERE current_version_id = @id::text
)
DELETE FROM versions WHERE id = @id::text;

-- name: EmptyOldOperations :execrows
-- Takes the replacements out of up to row_limit operations of the versions
-- that were sealed more than max_age_seconds ago, and that are older than
-- that themselves. The versions hold their content, and no page follows
-- from that far. The rows stay, so that a repeat of an operation is known.
UPDATE document_ops SET replacements = NULL WHERE (document_id, seq) IN (
  SELECT o.document_id, o.seq FROM document_ops o
  JOIN versions v ON v.id = o.version_id
  WHERE o.replacements IS NOT NULL
    AND v.sealed_at < now() - make_interval(secs => @max_age_seconds)
    AND o.created_at < now() - make_interval(secs => @max_age_seconds)
  LIMIT @row_limit
);

-- name: DeleteOldOperations :execrows
-- Deletes up to row_limit operations that have no replacements and are
-- older than max_age_seconds. No tab sends an operation again after that
-- long.
DELETE FROM document_ops WHERE (document_id, seq) IN (
  SELECT o.document_id, o.seq FROM document_ops o
  WHERE o.replacements IS NULL AND o.created_at < now() - make_interval(secs => @max_age_seconds)
  LIMIT @row_limit
);
