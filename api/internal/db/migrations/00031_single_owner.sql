-- +goose Up
-- A document or folder has exactly one owner: the principal in its owner_type
-- and owner_id columns. Owner-level Google Group grants let group members
-- delete resources and, through folder inheritance, take ownership of
-- documents that other users moved into their folders. They become editor
-- grants, and the constraint keeps owner out of resource_grants.
UPDATE resource_grants SET role='editor' WHERE role='owner';

ALTER TABLE resource_grants
  ADD CONSTRAINT resource_grants_role_check CHECK (role IN ('viewer','commenter','editor'));

-- +goose Down
ALTER TABLE resource_grants DROP CONSTRAINT resource_grants_role_check;
