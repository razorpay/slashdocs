-- +goose Up
-- folder_subtrees returns the folders in roots and every folder below them.
-- Search uses it for the folders that a principal can read and for the in:
-- filter. The function is plpgsql, which the planner does not inline, so the
-- ROWS estimate holds: it keeps the planner from treating the recursion as
-- hundreds of thousands of rows, which made it scan the result once per
-- document instead of hashing it.
-- +goose StatementBegin
CREATE FUNCTION folder_subtrees(roots text[]) RETURNS SETOF text
LANGUAGE plpgsql STABLE ROWS 1000 AS $$
BEGIN
  RETURN QUERY
    WITH RECURSIVE subtree(id) AS (
      SELECT f.id FROM folders f WHERE f.id = ANY(roots)
      UNION
      SELECT f.id FROM folders f JOIN subtree s ON f.parent_folder_id = s.id
    )
    SELECT s.id FROM subtree s;
END;
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION IF EXISTS folder_subtrees(text[]);
