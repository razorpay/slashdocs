package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/books"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// systemActor records outline versions that the server writes by itself:
// placeholder fills and removals. The created-by columns are text, not
// foreign keys.
var systemActor = auth.Principal{Type: auth.PrincipalUser, ID: "system"}

// Lock order for every outline writer (A8): the folder-tree advisory lock
// first, where the path takes it, then the documents row, then the books row
// (GetBookForUpdate), then version rows (ensureSections). The book row lock
// is taken before the outline is read, so that writers never build on a
// stale outline.

func (s *Store) CreateBook(ctx context.Context, folderID string, outline books.Outline, actor auth.Principal) (repo.Book, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Book{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	// Serialize with moves into and out of the folder, so that the chapters
	// placed here are still in the folder when the book appears.
	if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
		return repo.Book{}, err
	}
	if _, err := q.GetBookByFolder(ctx, folderID); err == nil {
		return repo.Book{}, repo.ErrConflict
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return repo.Book{}, err
	}
	id := newID("book")
	if err := q.InsertBook(ctx, dbsqlc.InsertBookParams{ID: id, FolderID: folderID, CreatedByType: string(actor.Type), CreatedByID: actor.ID}); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23503": // folder does not exist
				return repo.Book{}, repo.ErrNotFound
			case "23505": // folder already is a book
				return repo.Book{}, repo.ErrConflict
			}
		}
		return repo.Book{}, err
	}
	if _, _, err := insertOutline(ctx, q, id, outline, "Book created", actor); err != nil {
		return repo.Book{}, err
	}
	// A12: the chapters a book places are indexed now; everything else is
	// indexed on demand.
	for _, docID := range books.DocIDs(outline) {
		if err := s.indexChapter(ctx, q, folderID, docID); err != nil {
			return repo.Book{}, err
		}
	}
	b, err := getBook(ctx, q, id)
	if err != nil {
		return repo.Book{}, err
	}
	return b, tx.Commit(ctx)
}

// indexChapter indexes the current version of a document in folderID. A
// document that is gone or elsewhere is skipped: the handler validates the
// outline, and a read-time prune drops what it missed.
func (s *Store) indexChapter(ctx context.Context, q *dbsqlc.Queries, folderID, docID string) error {
	d, err := q.GetDocument(ctx, docID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load chapter %s: %w", docID, err)
	}
	if d.ParentFolderID != folderID || !d.CurrentVersionID.Valid {
		return nil
	}
	return s.ensureSections(ctx, q, d.CurrentVersionID.String)
}

func (s *Store) GetBook(ctx context.Context, id string) (repo.Book, error) {
	return getBook(ctx, s.q, id)
}

// getBook loads a book with its current outline through q, which may be
// transaction-scoped.
func getBook(ctx context.Context, q *dbsqlc.Queries, id string) (repo.Book, error) {
	r, err := q.GetBook(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Book{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Book{}, err
	}
	b := repo.Book{ID: r.ID, FolderID: r.FolderID, OutlineVersionID: r.OutlineVersionID, OutlineNumber: int(r.OutlineNumber), CreatedAt: pgTimeRFC3339(r.CreatedAt)}
	if err := json.Unmarshal(r.Outline, &b.Outline); err != nil {
		return repo.Book{}, fmt.Errorf("decode outline of book %s: %w", id, err)
	}
	return b, nil
}

func (s *Store) GetBookIDByFolder(ctx context.Context, folderID string) (string, error) {
	id, err := s.q.GetBookByFolder(ctx, folderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", repo.ErrNotFound
	}
	return id, err
}

func (s *Store) DeleteBook(ctx context.Context, id string) error {
	n, err := s.q.DeleteBook(ctx, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return repo.ErrNotFound
	}
	return nil
}

func (s *Store) PushOutline(ctx context.Context, bookID, baseVersionID string, outline books.Outline, note string, actor auth.Principal) (repo.Book, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Book{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	cur, err := q.GetBookForUpdate(ctx, bookID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Book{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Book{}, err
	}
	if cur.OutlineVersionID != baseVersionID {
		return repo.Book{}, &repo.OutlineConflictError{CurrentVersionID: cur.OutlineVersionID}
	}
	if _, _, err := insertOutline(ctx, q, bookID, outline, note, actor); err != nil {
		return repo.Book{}, err
	}
	b, err := getBook(ctx, q, bookID)
	if err != nil {
		return repo.Book{}, err
	}
	return b, tx.Commit(ctx)
}

func (s *Store) ListOutlineVersions(ctx context.Context, bookID string) ([]repo.OutlineVersion, error) {
	rows, err := s.q.ListOutlineVersions(ctx, bookID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.OutlineVersion, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.OutlineVersion{
			ID:         r.ID,
			Number:     int(r.Number),
			ChangeNote: r.ChangeNote,
			CreatedBy:  auth.Principal{Type: auth.PrincipalType(r.CreatedByType), ID: r.CreatedByID},
			CreatedAt:  pgTimeRFC3339(r.CreatedAt),
		})
	}
	return out, nil
}

// insertOutline saves o as the book's next outline version and makes it
// current. Callers hold the book row lock (or created the book in this
// transaction), so the next number cannot be taken concurrently.
func insertOutline(ctx context.Context, q *dbsqlc.Queries, bookID string, o books.Outline, note string, actor auth.Principal) (string, int, error) {
	n, err := q.NextOutlineNumber(ctx, bookID)
	if err != nil {
		return "", 0, fmt.Errorf("next outline number of book %s: %w", bookID, err)
	}
	raw, err := json.Marshal(storedOutline(o))
	if err != nil {
		return "", 0, fmt.Errorf("encode outline of book %s: %w", bookID, err)
	}
	id := newID("bov")
	if err := q.InsertOutlineVersion(ctx, dbsqlc.InsertOutlineVersionParams{
		ID: id, BookID: bookID, Number: n, Outline: raw, ChangeNote: note,
		CreatedByType: string(actor.Type), CreatedByID: actor.ID,
	}); err != nil {
		return "", 0, fmt.Errorf("insert outline version of book %s: %w", bookID, err)
	}
	if err := q.SetCurrentOutline(ctx, dbsqlc.SetCurrentOutlineParams{VersionID: pgtype.Text{String: id, Valid: true}, BookID: bookID}); err != nil {
		return "", 0, fmt.Errorf("set current outline of book %s: %w", bookID, err)
	}
	return id, int(n), nil
}

// storedOutline replaces nil lists with empty ones, so that a stored outline
// encodes lists as [] and never as null.
func storedOutline(o books.Outline) books.Outline {
	if o.Front == nil {
		o.Front = []books.Entry{}
	}
	if o.Back == nil {
		o.Back = []books.Entry{}
	}
	parts := make([]books.Part, len(o.Parts))
	for i, p := range o.Parts {
		if p.Chapters == nil {
			p.Chapters = []books.Entry{}
		}
		parts[i] = p
	}
	o.Parts = parts
	return o
}

// lockFolderBook returns the book on folderID locked for update, or ok=false
// when the folder is not a book (or its book was deleted meanwhile).
func lockFolderBook(ctx context.Context, q *dbsqlc.Queries, folderID string) (repo.Book, bool, error) {
	if folderID == "" {
		return repo.Book{}, false, nil
	}
	id, err := q.GetBookByFolder(ctx, folderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Book{}, false, nil
	}
	if err != nil {
		return repo.Book{}, false, fmt.Errorf("find book of folder %s: %w", folderID, err)
	}
	if _, err := q.GetBookForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return repo.Book{}, false, nil
	} else if err != nil {
		return repo.Book{}, false, fmt.Errorf("lock book %s: %w", id, err)
	}
	b, err := getBook(ctx, q, id)
	if err != nil {
		return repo.Book{}, false, err
	}
	return b, true, nil
}

// fillFolderPlaceholder puts a document that moved into folderID into the
// matching placeholder of the folder's book, if there is one, and indexes the
// document's current version (A12).
func (s *Store) fillFolderPlaceholder(ctx context.Context, q *dbsqlc.Queries, folderID string, doc dbsqlc.GetDocumentRow) error {
	b, ok, err := lockFolderBook(ctx, q, folderID)
	if err != nil || !ok {
		return err
	}
	o, n, filled := books.FillPlaceholder(b.Outline, books.DocTitle{ID: doc.ID, Title: doc.Title})
	if !filled {
		return nil
	}
	if _, _, err := insertOutline(ctx, q, b.ID, o, fmt.Sprintf("Chapter %d filled by %s", n, doc.ID), systemActor); err != nil {
		return err
	}
	if !doc.CurrentVersionID.Valid {
		return nil
	}
	return s.ensureSections(ctx, q, doc.CurrentVersionID.String)
}

// Reasons recorded when a document leaves a book (A10).
const (
	removedDeleted  = "document deleted"
	removedMovedOut = "moved out"
)

// removeFromFolderBook drops docID from the outline of folderID's book, if it
// is listed there, as a new outline version noting why (A10).
func removeFromFolderBook(ctx context.Context, q *dbsqlc.Queries, folderID, docID, reason string) error {
	b, ok, err := lockFolderBook(ctx, q, folderID)
	if err != nil || !ok {
		return err
	}
	var slot *books.Numbered
	for _, x := range books.Number(b.Outline) {
		if x.Doc == docID {
			slot = &x
			break
		}
	}
	if slot == nil {
		return nil
	}
	present := map[string]bool{}
	for _, id := range books.DocIDs(b.Outline) {
		present[id] = id != docID
	}
	o, _ := books.Prune(b.Outline, present)
	_, _, err = insertOutline(ctx, q, b.ID, o, removalNote(*slot, reason), systemActor)
	return err
}

func removalNote(slot books.Numbered, reason string) string {
	switch slot.Kind {
	case books.KindFront:
		return "Front matter removed: " + reason
	case books.KindBack:
		return "Back matter removed: " + reason
	default:
		return fmt.Sprintf("Chapter %d removed: %s", slot.Number, reason)
	}
}
