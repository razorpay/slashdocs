-- +goose Up
ALTER TABLE comments ADD COLUMN edited boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE comments DROP COLUMN edited;
