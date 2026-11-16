-- +goose Up
-- Access checks find the grants on a document and its folders by resource_id
-- alone. idx_grants_resource starts with resource_type, so it cannot serve
-- them, and each check read the whole table.
CREATE INDEX IF NOT EXISTS idx_grants_resource_id
  ON resource_grants(resource_id) WHERE revoked_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_grants_resource_id;
