-- +goose NO TRANSACTION
-- +goose Up
-- Move-tree search is global and uses a contains match; keep it off a full
-- folders scan. Child expansion and title/id keyset pagination share the
-- second index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_folders_title_trgm
  ON folders USING GIN (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_folders_parent_title_id
  ON folders (parent_folder_id, (lower(title) COLLATE "C"), id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_folders_owner_title_id
  ON folders (owner_type, owner_id, (lower(title) COLLATE "C"), id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_resource_grants_active_principal_folder
  ON resource_grants (principal_type, principal_id, resource_id)
  WHERE resource_type = 'folder' AND revoked_at IS NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS idx_folders_parent_title_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_folders_owner_title_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_resource_grants_active_principal_folder;
DROP INDEX CONCURRENTLY IF EXISTS idx_folders_title_trgm;
