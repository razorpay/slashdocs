-- name: UpsertGitHubConnection :exec
INSERT INTO github_connections(user_id, github_user_id, login, avatar_url, access_token_ciphertext)
VALUES($1,$2,$3,$4,$5)
ON CONFLICT(user_id) DO UPDATE SET
  github_user_id=EXCLUDED.github_user_id,
  login=EXCLUDED.login,
  avatar_url=EXCLUDED.avatar_url,
  access_token_ciphertext=EXCLUDED.access_token_ciphertext,
  updated_at=now();

-- name: GetGitHubConnection :one
SELECT user_id, github_user_id, login, avatar_url, access_token_ciphertext, updated_at
FROM github_connections WHERE user_id=$1;

-- name: DeleteGitHubConnection :execrows
DELETE FROM github_connections WHERE user_id=$1;

-- name: ListGitHubAuthorAccess :many
-- One row for each principal who created a version of the document. user_id
-- is the user whose GitHub access counts for the author: the author, or the
-- owner of a service account, because the owner controls its keys. The row
-- also has that user's sealed GitHub token (NULL when not connected) and the
-- cached access answer (NULL when missing, older than fresh_after, or older
-- than the user's last GitHub connection).
SELECT DISTINCT v.created_by_type, v.created_by_id, u.id AS user_id, g.access_token_ciphertext, a.can_read
FROM versions v
LEFT JOIN service_accounts sa -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
  ON v.created_by_type = 'service_account' AND sa.id = v.created_by_id
LEFT JOIN users u
  ON u.id = CASE v.created_by_type WHEN 'user' THEN v.created_by_id WHEN 'service_account' THEN sa.owner_user_id END
LEFT JOIN github_connections g ON g.user_id = u.id
LEFT JOIN github_repo_access a
  ON a.user_id = g.user_id AND a.owner = @owner AND a.repo = @repo
  AND a.checked_at > GREATEST(g.updated_at, @fresh_after::timestamptz)
WHERE v.document_id = @document_id;

-- name: UpsertGitHubRepoAccess :exec
-- Selecting from github_connections skips the write when the user
-- disconnected GitHub during the check.
INSERT INTO github_repo_access(user_id, owner, repo, can_read)
SELECT g.user_id, @owner, @repo, @can_read FROM github_connections g WHERE g.user_id = @user_id
ON CONFLICT (user_id, owner, repo) DO UPDATE SET
  can_read = EXCLUDED.can_read,
  checked_at = now();
