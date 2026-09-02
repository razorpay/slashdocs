-- name: AcquireFolderTreeLock :exec
-- Serializes folder-structure mutations (create under a parent, re-parent,
-- delete, move documents) for the rest of the transaction. Cycle and depth
-- invariants are check-then-write and cannot be expressed as constraints, so
-- concurrent tree mutations must not interleave. Folder trees are small and
-- mutations rare; one global transaction-scoped advisory lock keeps this
-- simple and obviously correct.
SELECT pg_advisory_xact_lock(@lock_id);

-- name: InsertFolder :exec
INSERT INTO folders(id,title,owner_type,owner_id,parent_folder_id)
VALUES(@id,@title,@owner_type,@owner_id,NULLIF(@parent_folder_id::text,''));

-- name: GetFolder :one
SELECT f.id, f.title, f.owner_type, f.owner_id,
       COALESCE(f.parent_folder_id,'') AS parent_folder_id,
       COALESCE(u.name,sa.name,'') AS owner_name,
       COALESCE(u.email,'') AS owner_email
FROM folders f
LEFT JOIN users u ON f.owner_type='user' AND f.owner_id=u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON f.owner_type='service_account' AND f.owner_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE f.id= @id;

-- name: ListFolderAncestors :many
-- Breadcrumbs for a folder: its ancestors starting from @folder_id upwards,
-- returned root-first.
WITH RECURSIVE anc(id, title, parent, depth) AS (
  SELECT f.id, f.title, COALESCE(f.parent_folder_id,''), 1
  FROM folders f WHERE f.id= @folder_id
  UNION ALL
  SELECT f.id, f.title, COALESCE(f.parent_folder_id,''), a.depth+1
  FROM folders f JOIN anc a ON f.id=a.parent
  WHERE a.parent != '' AND a.depth < sqlc.arg(max_depth)::int
)
SELECT id, title FROM anc ORDER BY depth DESC;

-- name: GetFolderDepth :one
-- Number of folders on the path from @folder_id up to its root (0 when the
-- folder does not exist).
WITH RECURSIVE a(fid, depth) AS (
  SELECT f0.id, 1 FROM folders f0 WHERE f0.id = @folder_id
  UNION ALL
  SELECT f.id, a.depth+1
  FROM folders f
  JOIN a ON f.id=(SELECT parent_folder_id FROM folders WHERE folders.id=a.fid)
  WHERE a.depth < 64 AND (SELECT parent_folder_id FROM folders WHERE folders.id=a.fid) IS NOT NULL
)
SELECT COALESCE(MAX(depth),0)::int AS depth FROM a;

-- name: GetFolderSubtreeHeight :one
-- Height of the subtree rooted at @folder_id, counting the folder itself.
WITH RECURSIVE d(id, depth) AS (
  SELECT @folder_id::text, 1
  UNION ALL
  SELECT f.id, d.depth+1 FROM folders f JOIN d ON f.parent_folder_id=d.id WHERE d.depth < 64
)
SELECT COALESCE(MAX(depth),0)::int AS height FROM d;

-- name: IsFolderAncestorOf :one
-- Reports whether @folder_id appears on the ancestor chain that starts at
-- @start_id (inclusive). Used to reject re-parenting that would create a cycle.
WITH RECURSIVE chain_up AS (
  SELECT f0.id AS fid, 1 AS depth FROM folders f0 WHERE f0.id = @start_id
  UNION ALL
  SELECT f.parent_folder_id AS fid, cu.depth+1 AS depth
  FROM folders f JOIN chain_up cu ON f.id = cu.fid
  WHERE f.parent_folder_id IS NOT NULL AND cu.depth < 64
)
SELECT (COUNT(*) > 0)::bool AS is_ancestor FROM chain_up WHERE fid = @folder_id::text;

-- name: UpdateFolderTitleAndParent :exec
UPDATE folders SET title= @title, parent_folder_id=NULLIF(@parent_folder_id::text,''), updated_at=now() WHERE id= @id;

-- name: UpdateFolderTitle :exec
UPDATE folders SET title= @title, updated_at=now() WHERE id= @id;

-- name: UpdateFolderParent :exec
UPDATE folders SET parent_folder_id=NULLIF(@parent_folder_id::text,''), updated_at=now() WHERE id= @id;

-- name: GetFolderOwnership :one
SELECT EXISTS(SELECT 1 FROM folders f WHERE f.id = @folder_id)::bool AS folder_exists,
       EXISTS(SELECT 1 FROM folders f WHERE f.id = @folder_id AND f.owner_type = @owner_type AND f.owner_id = @owner_id)::bool AS is_owner;

-- name: ListFolderSubtreeOrphans :many
-- The folders that other principals own directly inside the folders that
-- DeleteFolderSubtree removes. Like Google Drive, a folder delete keeps them.
WITH RECURSIVE d(id, depth) AS (
  SELECT @folder_id::text, 1
  UNION ALL
  SELECT f.id, d.depth+1 FROM folders f JOIN d ON f.parent_folder_id=d.id
  WHERE d.depth < 64 AND f.owner_type= @owner_type AND f.owner_id= @owner_id
)
SELECT f.id, f.title, f.owner_type, f.owner_id
FROM folders f JOIN d ON f.parent_folder_id=d.id
WHERE NOT (f.owner_type= @owner_type AND f.owner_id= @owner_id);

-- name: DeleteFolderSubtree :execrows
-- Deletes the folder and every folder below it that the same principal owns.
-- The walk stops at folders that other principals own.
WITH RECURSIVE d(id, depth) AS (
  SELECT @folder_id::text, 1
  UNION ALL
  SELECT f.id, d.depth+1 FROM folders f JOIN d ON f.parent_folder_id=d.id
  WHERE d.depth < 64 AND f.owner_type= @owner_type AND f.owner_id= @owner_id
)
DELETE FROM folders WHERE id IN (SELECT id FROM d);

-- name: RootFolderTitleTaken :one
SELECT EXISTS(
  SELECT 1 FROM folders
  WHERE parent_folder_id IS NULL AND owner_type= @owner_type AND owner_id= @owner_id AND lower(title)=lower(@title)
)::bool;

-- name: FindRootFoldersByTitle :many
-- Resolves the first segment of a folder path: root folders with the given
-- title that the principal owns or can reach through a grant. Owned folders
-- sort first so an owned folder wins over a same-named shared one.
SELECT f.id, f.title, f.owner_type, f.owner_id,
       COALESCE(u.name,sa.name,'') AS owner_name, COALESCE(u.email,'') AS owner_email
FROM folders f
LEFT JOIN users u ON f.owner_type='user' AND f.owner_id=u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON f.owner_type='service_account' AND f.owner_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE COALESCE(f.parent_folder_id,'')=''
  AND lower(f.title)=lower(@title)
  AND (
    (f.owner_type= @principal_type AND f.owner_id= @principal_id)
    OR EXISTS (
      SELECT 1 FROM resource_grants g
      WHERE g.resource_type='folder' AND g.resource_id=f.id
        AND g.revoked_at IS NULL
        AND ((g.principal_type= @principal_type AND g.principal_id= @principal_id)
          OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
          OR g.principal_type='anyone')
    )
  )
ORDER BY CASE WHEN f.owner_type= @principal_type AND f.owner_id= @principal_id THEN 0 ELSE 1 END;

-- name: FindChildFolderIDByTitle :one
SELECT id FROM folders WHERE parent_folder_id= @parent_folder_id::text AND lower(title)=lower(@title) LIMIT 1;

-- name: ListRootFolderEntries :many
-- A principal's folder workspace: root folders they own or hold an explicit
-- grant on, root folders they opened that are still shared with "anyone", and
-- shared subfolders they opened whose ancestors they have no workspace entry
-- for (so a folder deep in someone else's tree surfaces at the top level).
WITH RECURSIVE anc(folder_id, ancestor_id, depth) AS (
  SELECT c.id, c.parent_folder_id, 1 FROM folders c WHERE c.parent_folder_id IS NOT NULL
  UNION ALL
  SELECT a.folder_id, p.parent_folder_id, a.depth+1
  FROM folders p JOIN anc a ON p.id=a.ancestor_id
  WHERE p.parent_folder_id IS NOT NULL AND a.depth < 20
)
SELECT f.id, f.title, f.owner_type, f.owner_id,
       COALESCE(f.parent_folder_id,'') AS parent_folder_id,
       COALESCE(u.name,sa.name,'') AS owner_name, COALESCE(u.email,'') AS owner_email,
       COALESCE(we.last_opened_at, f.created_at)::timestamptz AS last_active
FROM folders f
LEFT JOIN users u ON f.owner_type='user' AND f.owner_id=u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON f.owner_type='service_account' AND f.owner_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN folder_workspace_entries we ON we.folder_id=f.id AND we.principal_type= @principal_type AND we.principal_id= @principal_id
WHERE (
  COALESCE(f.parent_folder_id,'')=''
  AND (
    (f.owner_type= @principal_type AND f.owner_id= @principal_id)
    OR EXISTS (
      SELECT 1 FROM resource_grants g
      WHERE g.resource_type='folder' AND g.resource_id=f.id
        AND g.revoked_at IS NULL
        AND ((g.principal_type= @principal_type AND g.principal_id= @principal_id)
          OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[])))
    )
    OR (
      EXISTS (
        SELECT 1 FROM folder_workspace_entries w
        WHERE w.folder_id=f.id
          AND w.principal_type= @principal_type AND w.principal_id= @principal_id
      )
      AND EXISTS (
        SELECT 1 FROM resource_grants g
        WHERE g.resource_type='folder' AND g.resource_id=f.id
          AND g.revoked_at IS NULL
          AND g.principal_type='anyone'
      )
    )
  )
)
OR (
  f.parent_folder_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM folder_workspace_entries w
    WHERE w.folder_id=f.id
      AND w.principal_type= @principal_type AND w.principal_id= @principal_id
  )
  -- A workspace row is only a recency signal, never an authorization grant.
  -- Re-check the same effective folder access used by FolderAccessChain:
  -- ownership of this folder, or an active direct/inherited principal/anyone
  -- grant on this folder or one of its ancestors.
  AND (
    (f.owner_type= @principal_type AND f.owner_id= @principal_id)
    OR EXISTS (
      SELECT 1 FROM resource_grants g
      WHERE g.resource_type='folder' AND g.revoked_at IS NULL
        AND (
          g.resource_id=f.id
          OR EXISTS (
            SELECT 1 FROM anc granted_ancestor
            WHERE granted_ancestor.folder_id=f.id
              AND granted_ancestor.ancestor_id=g.resource_id
          )
        )
        AND (
          (g.principal_type= @principal_type AND g.principal_id= @principal_id)
          OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
          OR g.principal_type='anyone'
        )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM folder_workspace_entries fw
    JOIN anc ON fw.folder_id=anc.ancestor_id
    WHERE anc.folder_id=f.id
      AND fw.principal_type= @principal_type AND fw.principal_id= @principal_id
  )
)
ORDER BY COALESCE(we.last_opened_at, f.created_at) DESC
LIMIT 51;

-- name: ListChildFolders :many
SELECT f.id, f.title, f.owner_type, f.owner_id,
       COALESCE(f.parent_folder_id,'') AS parent_folder_id,
       COALESCE(u.name,sa.name,'') AS owner_name, COALESCE(u.email,'') AS owner_email,
       f.updated_at
FROM folders f
LEFT JOIN users u ON f.owner_type='user' AND f.owner_id=u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON f.owner_type='service_account' AND f.owner_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE COALESCE(f.parent_folder_id,'')= @parent_folder_id::text
ORDER BY f.title
LIMIT 51;

-- name: SearchFoldersByTitle :many
-- Compute the effective role for every folder before applying the result cap.
-- A grant on a folder is inherited by all descendants, so each candidate's
-- ancestor chain is folded into one maximum role. This is deliberately
-- set-wise: filtering after LIMIT would allow low-role rows to hide eligible
-- destinations from the move picker.
WITH RECURSIVE ancestors(folder_id, ancestor_id, depth) AS (
  SELECT f.id, f.id, 0
  FROM folders f
  UNION ALL
  SELECT a.folder_id, p.parent_folder_id, a.depth+1
  FROM ancestors a
  JOIN folders p ON p.id=a.ancestor_id
  WHERE p.parent_folder_id IS NOT NULL AND a.depth < 64
), effective_roles AS (
  SELECT f.id,
         GREATEST(
           CASE WHEN f.owner_type= @principal_type AND f.owner_id= @principal_id THEN 4 ELSE 0 END,
           COALESCE(MAX(CASE
             WHEN a.depth > 0
               AND ancestor_folder.owner_type= @principal_type
               AND ancestor_folder.owner_id= @principal_id
             THEN 3
             ELSE 0
           END), 0),
           COALESCE(MAX(CASE
             WHEN (g.principal_type= @principal_type AND g.principal_id= @principal_id)
               OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
               OR g.principal_type='anyone'
             THEN CASE g.role
               WHEN 'owner' THEN 4
               WHEN 'editor' THEN 3
               WHEN 'commenter' THEN 2
               WHEN 'viewer' THEN 1
               ELSE 0
             END
             ELSE 0
           END), 0)
         )::int AS role_rank,
         (f.owner_type= @principal_type AND f.owner_id= @principal_id)
           OR COALESCE(BOOL_OR(
             a.depth > 0
             AND ancestor_folder.owner_type= @principal_type
             AND ancestor_folder.owner_id= @principal_id
           ), false)
           OR COALESCE(BOOL_OR(
             (g.principal_type= @principal_type AND g.principal_id= @principal_id)
             OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
           ), false) AS has_private_access,
         COALESCE(BOOL_OR(g.principal_type='anyone'), false) AS has_anyone_access
  FROM folders f
  JOIN ancestors a ON a.folder_id=f.id
  JOIN folders ancestor_folder ON ancestor_folder.id=a.ancestor_id
  LEFT JOIN resource_grants g
    ON g.resource_type='folder'
   AND g.resource_id=a.ancestor_id
   AND g.revoked_at IS NULL
  GROUP BY f.id, f.owner_type, f.owner_id
)
SELECT f.id, f.title, f.owner_type, f.owner_id,
       COALESCE(f.parent_folder_id,'') AS parent_folder_id,
       COALESCE(u.name,sa.name,'') AS owner_name, COALESCE(u.email,'') AS owner_email
FROM folders f
JOIN effective_roles er ON er.id = f.id
LEFT JOIN users u ON f.owner_type='user' AND f.owner_id=u.id
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type, not a Google credential.
  ON f.owner_type='service_account' AND f.owner_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE f.title ILIKE '%' || @query::text || '%'
  AND er.role_rank > 0
  AND er.role_rank >= @min_role_rank::int
  -- Anyone-only folders are link-addressable but must not appear in the
  -- public search index. In org deployment, anyone grants are workspace-wide
  -- discovery grants. Private access and effective role are intentionally
  -- separate: a direct viewer plus an inherited anyone editor is discoverable
  -- and qualifies for min_role=editor.
  AND (er.has_private_access OR (@include_org_wide::boolean AND er.has_anyone_access))
ORDER BY f.title, f.id
LIMIT @row_limit;

-- name: FolderMayBroadenAccess :one
-- Whether placing content of the given owner inside the folder may broaden
-- who can see that content: the folder or one of its ancestors carries an
-- active grant or has another owner, whose ownership cascades as editor.
WITH RECURSIVE anc(fid, depth) AS (
  SELECT @folder_id::text, 1
  UNION ALL
  SELECT f.parent_folder_id, a.depth+1 FROM folders f JOIN anc a ON f.id=a.fid WHERE f.parent_folder_id IS NOT NULL AND a.depth < 20
)
SELECT (EXISTS(
  SELECT 1 FROM resource_grants g
  JOIN anc ON g.resource_id=anc.fid
  WHERE g.resource_type='folder' AND g.revoked_at IS NULL
) OR EXISTS(
  SELECT 1 FROM folders f
  JOIN anc ON f.id=anc.fid
  WHERE (f.owner_type, f.owner_id) <> (@owner_type::text, @owner_id::text)
))::bool AS may_broaden;

-- name: RecordFolderWorkspaceEntry :exec
INSERT INTO folder_workspace_entries(folder_id,principal_type,principal_id,last_opened_at)
VALUES(@folder_id,@principal_type,@principal_id,now())
ON CONFLICT (folder_id,principal_type,principal_id) DO UPDATE SET last_opened_at=now();

-- name: ListFolderAccessChain :many
-- A folder's ancestor chain (root first, the folder itself last) annotated
-- with the principal's access at each level, resolved in one round trip. A
-- grant on a folder applies to it and everything below it, so the strongest
-- grant for chain element X is taken over X and all of X's ancestors
-- (chain elements with depth >= X's). The owner of a folder above X counts as
-- an editor grant: a resource has one owner, and editor is the most that a
-- grant can give. Rank order mirrors repo.MaxRole: owner=4, editor=3,
-- commenter=2, viewer=1.
WITH RECURSIVE chain(id, title, parent_folder_id, owner_type, owner_id, depth) AS (
  SELECT f.id, f.title, f.parent_folder_id, f.owner_type, f.owner_id, 0
  FROM folders f WHERE f.id= @folder_id
  UNION ALL
  SELECT f.id, f.title, f.parent_folder_id, f.owner_type, f.owner_id, c.depth+1
  FROM folders f JOIN chain c ON f.id=c.parent_folder_id
  WHERE c.depth < 64
)
SELECT c.id, c.title,
       (c.owner_type= @principal_type::text AND c.owner_id= @principal_id::text)::bool AS is_owner,
       GREATEST(
         COALESCE((
           SELECT max(CASE g.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
           FROM resource_grants g
           JOIN chain gc ON g.resource_id=gc.id
           WHERE gc.depth >= c.depth
             AND g.resource_type='folder' AND g.revoked_at IS NULL
             AND ((g.principal_type= @principal_type::text AND g.principal_id= @principal_id::text)
               OR (g.principal_type='google_group' AND g.principal_id=ANY(@google_group_ids::text[]))
               OR g.principal_type='anyone')
         ), 0),
         CASE WHEN EXISTS (
           SELECT 1 FROM chain oc
           WHERE oc.depth > c.depth
             AND oc.owner_type= @principal_type::text AND oc.owner_id= @principal_id::text
         ) THEN 3 ELSE 0 END
       )::int AS grant_rank
FROM chain c
ORDER BY c.depth DESC;
