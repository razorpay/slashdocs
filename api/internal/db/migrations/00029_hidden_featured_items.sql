-- +goose Up
-- Featured items are documents and folders that the server shows to every
-- principal. A row here hides one featured item for one principal.
CREATE TABLE hidden_featured_items (
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_type, principal_id, resource_id)
);

-- +goose Down
DROP TABLE hidden_featured_items;
