-- name: ListHiddenFeaturedItems :many
SELECT resource_id FROM hidden_featured_items WHERE principal_type= @principal_type AND principal_id= @principal_id;

-- name: HideFeaturedItem :exec
INSERT INTO hidden_featured_items(principal_type,principal_id,resource_id)
VALUES(@principal_type,@principal_id,@resource_id)
ON CONFLICT DO NOTHING;
