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
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON d.owner_type='service_account' AND sa.id=d.owner_id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
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
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON d.owner_type='service_account' AND sa.id=d.owner_id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
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
-- @match_query, @words_query, @exclude_query, and @rank_query are tsquery
-- text. A document matches when its title or current text matches
-- match_query. words_query is the words of match_query in any order; it
-- differs from match_query only when a term is a phrase. Documents whose
-- title matches rank_query (the words joined with |) come first, then the
-- latest. The rank reads titles only: ranking the text would read the whole
-- vector of every matching document.
--
-- candidates are narrow rows, so that the index match, the access check,
-- and the sort touch no text. The index finds the documents that have the
-- words. Whether they are in the order of a phrase is known from the text
-- vector only, so that check runs on the sorted candidates, in order, until
-- LIMIT rows pass. Owners, folders, and snippets are joined after LIMIT.
-- matches is MATERIALIZED, so that the planner joins 25 rows.
--
-- The two arms of matches keep the statement fast under a generic plan,
-- which PostgreSQL may choose for a prepared statement after five runs. With
-- the parameters unknown, "no words OR index match" cannot use the index and
-- reads every document's vector. Each arm has a condition on the parameters
-- only, which the executor checks once, so the arm that does not apply runs
-- nothing.
WITH search AS NOT MATERIALIZED (
  -- (SELECT ...) hides the words from the planner. When it sees them, it
  -- plans a sequential scan for a word that most documents have, and that
  -- scan reads every document's vector. Without them it uses the index,
  -- which reads none. NULLIF keeps to_tsquery from parsing an empty string,
  -- which raises a notice on every call.
  SELECT to_tsquery('english', NULLIF((SELECT @match_query::text), '')) AS match,
         to_tsquery('english', NULLIF((SELECT @words_query::text), '')) AS words,
         to_tsquery('english', NULLIF((SELECT @exclude_query::text), '')) AS exclude
),
-- MATERIALIZED, so that the rank query is parsed once, not for every match.
ranking AS MATERIALIZED (
  SELECT to_tsquery('english', NULLIF(@rank_query::text, '')) AS rank
),
named_owners AS (
  SELECT 'user' AS owner_type, u.id FROM users u
  WHERE lower(u.email) = ANY(@owners::text[]) OR lower(split_part(u.email, '@', 1)) = ANY(@owners::text[])
  UNION ALL
  SELECT 'service_account', sa.id FROM service_accounts sa WHERE lower(sa.name) = ANY(@owners::text[])
),
candidates AS NOT MATERIALIZED (
  SELECT d.id, d.title, d.updated_at, d.search_vector
  FROM documents d
  CROSS JOIN search
  -- A join, not EXISTS: the planner costs a correlated EXISTS per document,
  -- which made it JIT-compile the query.
  LEFT JOIN (
    SELECT DISTINCT g.resource_id FROM resource_grants g
    WHERE g.resource_type='document' AND g.revoked_at IS NULL
      AND ((g.principal_type= @owner_type AND g.principal_id= @owner_id)
        OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
        OR (@include_org_wide::boolean AND g.principal_type='anyone'))
  ) granted ON granted.resource_id=d.id
  -- The subquery finds the excluded documents in the index, once, and the
  -- planner hashes them. Without excluded words it finds none.
  WHERE d.id NOT IN (SELECT x.id FROM documents x WHERE x.search_vector @@ search.exclude)
  AND (
    COALESCE(cardinality(@owners::text[]), 0) = 0
    OR lower(d.owner_id) = ANY(@owners::text[])
    OR (d.owner_type, d.owner_id) IN (SELECT owner_type, id FROM named_owners)
  )
  AND (
    COALESCE(cardinality(@folders::text[]), 0) = 0
    OR d.parent_folder_id IN (
      SELECT subtree.id FROM folder_subtrees(ARRAY(
        SELECT f.id FROM folders f
        WHERE f.id = ANY(@folders::text[]) OR lower(f.title) = ANY(@folders::text[]))) AS subtree(id)
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM unnest(@labels::text[]) AS requested_label
    WHERE NOT EXISTS (
      SELECT 1 FROM document_labels dl
      WHERE dl.document_id=d.id AND dl.label = requested_label
    )
  )
  AND (sqlc.narg('updated_since')::timestamptz IS NULL OR d.updated_at >= sqlc.narg('updated_since'))
  AND (sqlc.narg('updated_before')::timestamptz IS NULL OR d.updated_at < sqlc.narg('updated_before'))
  AND (
    (d.owner_type= @owner_type AND d.owner_id= @owner_id)
    OR granted.resource_id IS NOT NULL
    OR d.parent_folder_id IN (
      SELECT subtree.id FROM folder_subtrees(ARRAY(
        SELECT g.resource_id FROM resource_grants g
        WHERE g.resource_type='folder' AND g.revoked_at IS NULL
          AND ((g.principal_type= @owner_type AND g.principal_id= @owner_id)
            OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
            OR (@include_org_wide::boolean AND g.principal_type='anyone')))) AS subtree(id)
    )
  )
),
matches AS MATERIALIZED (
  (
    SELECT o.id, o.title, o.updated_at, o.rank
    FROM (
      SELECT c.id, c.title, c.updated_at, c.search_vector,
             ts_rank(to_tsvector('english', c.title), ranking.rank) AS rank
      FROM candidates c
      CROSS JOIN search
      CROSS JOIN ranking
      WHERE numnode(search.words) > 0 AND c.search_vector @@ search.words
      ORDER BY rank DESC, c.updated_at DESC, c.title
      -- OFFSET 0 keeps the planner from moving the condition below into
      -- this subquery, where it would run before the sort, on every
      -- candidate. The sort carries a reference to each vector, not the
      -- vector; the condition reads it.
      OFFSET 0
    ) o
    CROSS JOIN search
    WHERE o.search_vector @@ search.match
    ORDER BY o.rank DESC, o.updated_at DESC, o.title
    LIMIT @row_limit
  )
  UNION ALL
  (
    -- Without words, every candidate matches, the latest first.
    SELECT c.id, c.title, c.updated_at, 0
    FROM candidates c
    CROSS JOIN search
    WHERE COALESCE(numnode(search.match), 0) = 0
    ORDER BY c.updated_at DESC, c.title
    LIMIT @row_limit
  )
  ORDER BY rank DESC, updated_at DESC, title
  LIMIT @row_limit
)
-- Snippets are made after LIMIT, because ts_headline reads the whole text.
SELECT d.id, d.title, d.current_version_id, d.owner_type, d.owner_id,
       COALESCE(u.email,'') AS owner_email,
       COALESCE(u.name,sa.name,'') AS owner_name,
       COALESCE(pf.id,'') AS parent_folder_id,
       COALESCE(pf.title,'') AS parent_folder_title,
       d.updated_at,
       CASE WHEN numnode(search.match) > 0 AND cv.search_vector @@ search.match
         THEN ts_headline('english', cv.search_text, search.match,
           'MaxFragments=1,MaxWords=24,MinWords=12,StartSel="'||chr(2)||'",StopSel="'||chr(3)||'"')
         ELSE '' END::text AS snippet
FROM matches m
JOIN documents d ON d.id=m.id
CROSS JOIN search
LEFT JOIN versions cv ON cv.id=d.current_version_id
LEFT JOIN folders pf ON pf.id=d.parent_folder_id
LEFT JOIN users u ON d.owner_type='user' AND u.id=d.owner_id
LEFT JOIN service_accounts sa
  ON d.owner_type='service_account' AND sa.id=d.owner_id
ORDER BY m.rank DESC, m.updated_at DESC, m.title;

-- name: IndexDocuments :execrows
-- The trigger on title sets search_vector. Servers that index at the same
-- time skip each other's documents.
UPDATE documents SET title = title
WHERE id IN (
  SELECT id FROM documents WHERE search_vector IS NULL
  LIMIT @row_limit
  FOR NO KEY UPDATE SKIP LOCKED
);

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
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON d.owner_type='service_account' AND d.owner_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE d.parent_folder_id= @folder_id::text;
