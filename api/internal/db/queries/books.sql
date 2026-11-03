-- name: InsertBook :exec
INSERT INTO books(id,folder_id,created_by_type,created_by_id) VALUES(@id,@folder_id,@created_by_type,@created_by_id);
-- name: GetBook :one
SELECT b.id,b.folder_id,COALESCE(b.current_outline_version_id,'') AS outline_version_id,
       COALESCE(v.number,0)::int AS outline_number, COALESCE(v.outline,'{}'::jsonb) AS outline, b.created_at
FROM books b LEFT JOIN book_outline_versions v ON v.id=b.current_outline_version_id WHERE b.id = @id;
-- name: GetBookByFolder :one
SELECT id FROM books WHERE folder_id = @folder_id;
-- name: GetBookForUpdate :one
SELECT id, COALESCE(current_outline_version_id,'') AS outline_version_id FROM books WHERE id = @id FOR UPDATE;
-- name: DeleteBook :execrows
DELETE FROM books WHERE id = @id;
-- name: NextOutlineNumber :one
SELECT (COALESCE(MAX(number),0)+1)::int FROM book_outline_versions WHERE book_id = @book_id;
-- name: InsertOutlineVersion :exec
INSERT INTO book_outline_versions(id,book_id,number,outline,change_note,created_by_type,created_by_id)
VALUES(@id,@book_id,@number,@outline,@change_note,@created_by_type,@created_by_id);
-- name: SetCurrentOutline :exec
UPDATE books SET current_outline_version_id = @version_id, updated_at=now() WHERE id = @book_id;
-- name: ListOutlineVersions :many
SELECT id,number,change_note,created_by_type,created_by_id,created_at FROM book_outline_versions WHERE book_id = @book_id ORDER BY number DESC;
-- name: InsertVersionSection :exec
INSERT INTO version_sections(version_id,ord,section_id,title,level,text_hash,words) VALUES(@version_id,@ord,@section_id,@title,@level,@text_hash,@words);
-- name: MarkVersionSectionsIndexed :exec
UPDATE versions SET sections_indexed=true WHERE id = @id;
-- name: ListVersionSections :many
SELECT ord,section_id,title,level,text_hash,words FROM version_sections WHERE version_id = @version_id ORDER BY ord;
-- name: ListUnsectionedVersions :many
-- Versions of documents in book folders that have no sections yet (A12). Locks
-- the rows, so that servers that index at the same time skip each other's.
SELECT v.id,v.html_blob_key FROM versions v
JOIN documents d ON d.id = v.document_id
JOIN books b ON b.folder_id = d.parent_folder_id
WHERE NOT v.sections_indexed AND v.id <> ALL(COALESCE(@skipped::text[], '{}'))
ORDER BY v.created_at LIMIT @row_limit FOR UPDATE OF v SKIP LOCKED;
-- name: GetVersionSectionsForUpdate :one
-- Locks the version so that concurrent on-demand indexing inserts its sections once.
SELECT sections_indexed, html_blob_key FROM versions WHERE id = @id FOR UPDATE;
-- name: DocumentInBook :one
SELECT EXISTS(SELECT 1 FROM documents d JOIN books b ON b.folder_id = d.parent_folder_id WHERE d.id = @document_id);
-- name: VersionWords :many
SELECT version_id, COALESCE(SUM(words),0)::int AS words FROM version_sections WHERE version_id = ANY(@version_ids::text[]) GROUP BY version_id;
-- name: ListVersionsAfter :many
-- Versions of a document newer than @after_version_id (all when empty), newest first.
SELECT v.id,v.number,v.change_summary,v.created_at FROM versions v
WHERE v.document_id = @document_id AND v.number > COALESCE((SELECT av.number FROM versions av WHERE av.id = @after_version_id),0)
ORDER BY v.number DESC;
-- name: GetChapterReads :many
SELECT document_id,COALESCE(seen_version_id,'') AS seen_version_id,COALESCE(last_read_version_id,'') AS last_read_version_id,
       furthest_progression,reached_end_at,done_at,last_opened_at
FROM chapter_reads WHERE user_id = @user_id AND document_id = ANY(@document_ids::text[]);
-- name: UpsertChapterOpen :exec
INSERT INTO chapter_reads(user_id,document_id,last_read_version_id,seen_version_id)
VALUES(@user_id,@document_id,@version_id,@version_id)
ON CONFLICT (user_id,document_id) DO UPDATE SET last_read_version_id=EXCLUDED.last_read_version_id, last_opened_at=now();
-- name: UpdateChapterProgress :exec
UPDATE chapter_reads SET furthest_progression=GREATEST(furthest_progression, @progression::real),
  reached_end_at=CASE WHEN @reached_end::bool AND reached_end_at IS NULL THEN now() ELSE reached_end_at END
WHERE user_id = @user_id AND document_id = @document_id;
-- name: SetChapterDone :exec
UPDATE chapter_reads SET done_at=CASE WHEN @done::bool THEN now() ELSE NULL END WHERE user_id = @user_id AND document_id = @document_id;
-- name: MarkChapterSeen :exec
-- Moves seen_version_id forward only, to the version given, never past it (A7).
UPDATE chapter_reads cr SET seen_version_id = @version_id
WHERE cr.user_id = @user_id AND cr.document_id = @document_id
  AND (SELECT nv.number FROM versions nv WHERE nv.id = @version_id) >= COALESCE((SELECT sv.number FROM versions sv WHERE sv.id = cr.seen_version_id),0);
-- name: UpsertReadingPosition :execrows
-- Applies only when newer than the stored client timestamp.
INSERT INTO reading_positions(user_id,book_id,device_id,document_id,version_id,section_id,anchor,progression,client_ts)
VALUES(@user_id,@book_id,@device_id,@document_id,@version_id,@section_id,@anchor,@progression,@client_ts)
ON CONFLICT (user_id,book_id,device_id) DO UPDATE SET document_id=EXCLUDED.document_id, version_id=EXCLUDED.version_id,
  section_id=EXCLUDED.section_id, anchor=EXCLUDED.anchor, progression=EXCLUDED.progression, client_ts=EXCLUDED.client_ts, updated_at=now()
WHERE reading_positions.client_ts < EXCLUDED.client_ts;
-- name: ListReadingPositions :many
SELECT device_id,document_id,version_id,section_id,anchor,progression,client_ts,updated_at
FROM reading_positions WHERE user_id = @user_id AND book_id = @book_id ORDER BY client_ts DESC;
