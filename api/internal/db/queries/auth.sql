-- name: ResolveCLIToken :one
SELECT 'user'::text AS principal_type, u.id, u.email, u.name, u.picture_url
FROM cli_credentials c JOIN users u ON u.id=c.user_id
WHERE c.token_hash=$1 AND c.revoked_at IS NULL;

-- name: TouchCLIToken :exec
UPDATE cli_credentials SET last_used_at=now() WHERE token_hash=$1;

-- name: ResolveServiceAccountToken :one
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
SELECT 'service_account'::text AS principal_type, sa.id, ''::text AS email, sa.name, ''::text AS picture_url -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
FROM service_account_keys k JOIN service_accounts sa ON sa.id=k.service_account_id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND sa.disabled_at IS NULL;

-- name: TouchServiceAccountToken :exec
-- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
UPDATE service_account_keys SET last_used_at=now() WHERE token_hash=$1; -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.

-- name: UpsertGoogleUser :exec
WITH updated AS (
  UPDATE users
  SET email=$2, name=$3, google_sub=$4, picture_url=$5
  WHERE google_sub=$4 OR (email=$2 AND google_sub IS NULL)
  RETURNING id
)
INSERT INTO users(id,email,name,google_sub,picture_url)
SELECT $1,$2,$3,$4,$5
WHERE NOT EXISTS (SELECT 1 FROM updated);

-- name: GetUserByEmail :one
SELECT id,email,name,picture_url FROM users WHERE email=$1;

-- name: GetSignedInUserByEmail :one
SELECT id,email,name,picture_url FROM users WHERE email=$1 AND google_sub IS NOT NULL;

-- name: SearchUsersByEmail :many
SELECT id,email,name,picture_url
FROM users
WHERE google_sub IS NOT NULL
  AND (
    lower(email) LIKE '%' || lower($1) || '%'
    OR lower(name) LIKE '%' || lower($1) || '%'
  )
ORDER BY
  CASE
    WHEN lower(email) = lower($1) THEN 0
    WHEN lower(name) = lower($1) THEN 1
    WHEN lower(email) LIKE lower($1) || '%' THEN 2
    WHEN lower(name) LIKE lower($1) || '%' THEN 3
    ELSE 4
  END,
  name,
  email
LIMIT 8;

-- name: SearchContacts :many
-- Public servers: a partial query matches only the caller's contacts, which
-- are the people the caller shares with and the people who share with the
-- caller. Other users match only by their exact email, as when sharing. The
-- query starts from the contacts, so its cost does not grow with all users.
SELECT id,email,name,picture_url
FROM users
WHERE google_sub IS NOT NULL
  AND (
    lower(email) LIKE '%' || lower(@query) || '%'
    OR lower(name) LIKE '%' || lower(@query) || '%'
  )
  AND id IN (
    SELECT sent.principal_id FROM resource_grants sent
    WHERE sent.revoked_at IS NULL AND sent.principal_type = 'user'
      AND sent.granted_by_type = @caller_type AND sent.granted_by_user_id = @caller_id
    UNION ALL
    SELECT received.granted_by_user_id FROM resource_grants received
    WHERE received.revoked_at IS NULL AND received.granted_by_type = 'user'
      AND received.principal_type = @caller_type AND received.principal_id = @caller_id
    UNION ALL
    SELECT @caller_id::text WHERE @caller_type = 'user'
    UNION ALL
    SELECT exact.id FROM users exact WHERE exact.email = @query
  )
ORDER BY
  CASE
    WHEN lower(email) = lower(@query) THEN 0
    WHEN lower(name) = lower(@query) THEN 1
    WHEN lower(email) LIKE lower(@query) || '%' THEN 2
    WHEN lower(name) LIKE lower(@query) || '%' THEN 3
    ELSE 4
  END,
  name,
  email
LIMIT 8;

-- name: GetUserByGoogleSub :one
SELECT id,email,name,picture_url FROM users WHERE google_sub=$1;

-- name: UpsertUser :exec
INSERT INTO users(id,email,name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name;

-- name: GetUserIDByEmail :one
SELECT id FROM users WHERE email=$1;

-- name: InsertPlaceholderUser :exec
INSERT INTO users(id,email,name) VALUES($1,$2,'');

-- name: GetUserByID :one
SELECT id, email, name, picture_url FROM users WHERE id = $1;

-- name: UserExists :one
SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)::bool;
