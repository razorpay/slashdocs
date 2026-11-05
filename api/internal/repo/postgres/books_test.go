package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/books"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
)

// bookFixture creates a user, a folder and a book on it with outline.
func bookFixture(t *testing.T, s *pgrepo.Store, outline books.Outline) (auth.Principal, repo.Folder, repo.Book) {
	t.Helper()
	ctx := context.Background()
	owner, err := s.EnsureUserByEmail(ctx, "book-owner@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	b, err := s.CreateBook(ctx, f.ID, outline, owner)
	if err != nil {
		t.Fatalf("CreateBook: %v", err)
	}
	return owner, f, b
}

func countRows(t *testing.T, s *pgrepo.Store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.Pool().QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func sectionsIndexed(t *testing.T, s *pgrepo.Store, versionID string) bool {
	t.Helper()
	var ok bool
	if err := s.Pool().QueryRow(context.Background(), `SELECT sections_indexed FROM versions WHERE id=$1`, versionID).Scan(&ok); err != nil {
		t.Fatalf("read sections_indexed: %v", err)
	}
	return ok
}

func mustGetBook(t *testing.T, s *pgrepo.Store, id string) repo.Book {
	t.Helper()
	b, err := s.GetBook(context.Background(), id)
	if err != nil {
		t.Fatalf("GetBook: %v", err)
	}
	return b
}

func mustOutlineVersions(t *testing.T, s *pgrepo.Store, bookID string) []repo.OutlineVersion {
	t.Helper()
	vs, err := s.ListOutlineVersions(context.Background(), bookID)
	if err != nil {
		t.Fatalf("ListOutlineVersions: %v", err)
	}
	return vs
}

func planned(titles ...string) books.Outline {
	p := books.Part{Title: "I", Chapters: []books.Entry{}}
	for _, title := range titles {
		p.Chapters = append(p.Chapters, books.Entry{Planned: title})
	}
	return books.Outline{Title: "Book", Front: []books.Entry{}, Parts: []books.Part{p}, Back: []books.Entry{}}
}

func TestCreateVersionIndexesSections(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, _ := bookFixture(t, s, planned())
	doc, v1, err := s.CreateDocument(ctx, owner, "01 · A", []byte(`<h2>X</h2><p>a b c</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder: %v", err)
	}
	if err := s.EnsureVersionSections(ctx, v1.ID); err != nil {
		t.Fatalf("EnsureVersionSections: %v", err)
	}
	secs, err := s.ListVersionSections(ctx, v1.ID)
	if err != nil {
		t.Fatalf("ListVersionSections: %v", err)
	}
	if len(secs) != 1 || secs[0].Words != 3 || secs[0].Title != "X" || secs[0].Level != 2 || secs[0].Order != 0 {
		t.Fatalf("v1 sections = %+v, want one section X with 3 words", secs)
	}
	v2, err := s.CreateVersion(ctx, doc.ID, v1.ID, "more", []byte(`<h2>X</h2><p>a b c d</p>`), owner)
	if err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}
	secs2, err := s.ListVersionSections(ctx, v2.ID)
	if err != nil {
		t.Fatalf("ListVersionSections v2: %v", err)
	}
	if len(secs2) != 1 || secs2[0].Hash == secs[0].Hash || secs2[0].Words != 4 {
		t.Fatalf("v2 sections = %+v, want one changed section with 4 words (v1 hash %s)", secs2, secs[0].Hash)
	}
	notes, err := s.ListVersionsAfter(ctx, doc.ID, v1.ID)
	if err != nil {
		t.Fatalf("ListVersionsAfter: %v", err)
	}
	if len(notes) != 1 || notes[0].ChangeSummary != "more" || notes[0].ID != v2.ID || notes[0].Number != 2 || notes[0].CreatedAt == "" {
		t.Fatalf("ListVersionsAfter = %+v, want only v2 with summary more", notes)
	}
	all, err := s.ListVersionsAfter(ctx, doc.ID, "")
	if err != nil || len(all) != 2 || all[0].ID != v2.ID {
		t.Fatalf("ListVersionsAfter(all) = %+v, %v; want v2 then v1", all, err)
	}
	words, err := s.VersionWords(ctx, []string{v1.ID, v2.ID, "ver_missing"})
	if err != nil {
		t.Fatalf("VersionWords: %v", err)
	}
	if words[v1.ID] != 3 || words[v2.ID] != 4 || len(words) != 2 {
		t.Fatalf("VersionWords = %v, want v1=3 v2=4", words)
	}
}

func TestPushOutlineConflictAndVersions(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, b := bookFixture(t, s, books.Outline{Title: "Book", Parts: []books.Part{{}}})
	if b.OutlineNumber != 1 || b.FolderID != f.ID || b.Outline.Title != "Book" || b.ID == "" || b.OutlineVersionID == "" || b.CreatedAt == "" {
		t.Fatalf("CreateBook = %+v", b)
	}
	if _, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "x"}, owner); !errors.Is(err, repo.ErrConflict) {
		t.Fatalf("second CreateBook err = %v, want ErrConflict", err)
	}
	if _, err := s.CreateBook(ctx, "fld_missing", books.Outline{Title: "x"}, owner); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("CreateBook on missing folder err = %v, want ErrNotFound", err)
	}
	if id, err := s.GetBookIDByFolder(ctx, f.ID); err != nil || id != b.ID {
		t.Fatalf("GetBookIDByFolder = %q, %v; want %q", id, err, b.ID)
	}
	b2, err := s.PushOutline(ctx, b.ID, b.OutlineVersionID, books.Outline{Title: "Book 2"}, "rename", owner)
	if err != nil {
		t.Fatalf("PushOutline: %v", err)
	}
	if b2.OutlineNumber != 2 || b2.Outline.Title != "Book 2" || b2.OutlineVersionID == b.OutlineVersionID {
		t.Fatalf("PushOutline = %+v, want version 2 titled Book 2", b2)
	}
	_, err = s.PushOutline(ctx, b.ID, b.OutlineVersionID, books.Outline{Title: "stale"}, "", owner)
	var ce *repo.OutlineConflictError
	if !errors.As(err, &ce) || !errors.Is(err, repo.ErrConflict) {
		t.Fatalf("stale PushOutline err = %v, want *OutlineConflictError", err)
	}
	if ce.CurrentVersionID != b2.OutlineVersionID {
		t.Fatalf("conflict current = %q, want %q", ce.CurrentVersionID, b2.OutlineVersionID)
	}
	if _, err := s.PushOutline(ctx, "book_missing", "", books.Outline{Title: "x"}, "", owner); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("PushOutline on missing book err = %v, want ErrNotFound", err)
	}
	vs := mustOutlineVersions(t, s, b.ID)
	if len(vs) != 2 || vs[0].ChangeNote != "rename" || vs[0].Number != 2 || vs[1].Number != 1 {
		t.Fatalf("ListOutlineVersions = %+v, want 2 then 1", vs)
	}
	if vs[0].CreatedBy.Type != auth.PrincipalUser || vs[0].CreatedBy.ID != owner.ID || vs[0].CreatedAt == "" {
		t.Fatalf("version 2 created by %+v at %q, want %s", vs[0].CreatedBy, vs[0].CreatedAt, owner.ID)
	}
	if got := mustGetBook(t, s, b.ID); got.OutlineVersionID != b2.OutlineVersionID || got.Outline.Title != "Book 2" {
		t.Fatalf("GetBook = %+v, want version 2", got)
	}
}

func TestBookNotFound(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if _, err := s.GetBook(ctx, "book_missing"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("GetBook err = %v, want ErrNotFound", err)
	}
	if _, err := s.GetBookIDByFolder(ctx, "fld_missing"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("GetBookIDByFolder err = %v, want ErrNotFound", err)
	}
	if err := s.DeleteBook(ctx, "book_missing"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("DeleteBook err = %v, want ErrNotFound", err)
	}
}

func TestMovingDocIntoBookFolderFillsPlaceholder(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, b := bookFixture(t, s, planned("Inference Internals"))
	doc, v, err := s.CreateDocument(ctx, owner, "01 · Inference Internals", []byte(`<h2>K</h2><p>x y</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder: %v", err)
	}
	got := mustGetBook(t, s, b.ID)
	if got.Outline.Parts[0].Chapters[0].Doc != doc.ID || got.OutlineNumber != 2 {
		t.Fatalf("outline after fill = %+v (number %d), want chapter 1 = %s at version 2", got.Outline, got.OutlineNumber, doc.ID)
	}
	vs := mustOutlineVersions(t, s, b.ID)
	if vs[0].ChangeNote != "Chapter 1 filled by "+doc.ID {
		t.Fatalf("change note = %q", vs[0].ChangeNote)
	}
	if vs[0].CreatedBy.Type != auth.PrincipalUser || vs[0].CreatedBy.ID != "system" {
		t.Fatalf("fill created by %+v, want user system", vs[0].CreatedBy)
	}
	// A12: a fill indexes the chapter's current version.
	if !sectionsIndexed(t, s, v.ID) {
		t.Fatal("filled chapter's current version is not indexed")
	}
	if secs, err := s.ListVersionSections(ctx, v.ID); err != nil || len(secs) != 1 {
		t.Fatalf("ListVersionSections = %+v, %v; want 1 section", secs, err)
	}
}

// TestMoveIntoNonBookFolderUnchanged is a regression test: with no book on the
// target folder, a move only sets parent_folder_id and reports grants.
func TestMoveIntoNonBookFolderUnchanged(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, err := s.EnsureUserByEmail(ctx, "move-owner@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	viewer, err := s.EnsureUserByEmail(ctx, "move-viewer@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	shared, err := s.CreateFolder(ctx, owner, "Shared", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	if _, err := s.CreateGrant(ctx, "folder", shared.ID, viewer, repo.RoleViewer, owner); err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}
	private, err := s.CreateFolder(ctx, owner, "Private", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	for _, tc := range []struct {
		folder    repo.Folder
		hasGrants bool
	}{{shared, true}, {private, false}} {
		doc, v, err := s.CreateDocument(ctx, owner, "01 · Doc in "+tc.folder.Title, []byte(`<h2>A</h2><p>a</p>`))
		if err != nil {
			t.Fatalf("CreateDocument: %v", err)
		}
		hasGrants, err := s.MoveDocumentToFolder(ctx, owner, tc.folder.ID, doc.ID)
		if err != nil {
			t.Fatalf("MoveDocumentToFolder(%s): %v", tc.folder.Title, err)
		}
		if hasGrants != tc.hasGrants {
			t.Fatalf("MoveDocumentToFolder(%s) hasGrants = %v, want %v", tc.folder.Title, hasGrants, tc.hasGrants)
		}
		got, err := s.GetDocument(ctx, doc.ID)
		if err != nil || got.ParentFolderID != tc.folder.ID {
			t.Fatalf("GetDocument = %+v, %v; want parent %s", got, err, tc.folder.ID)
		}
		if sectionsIndexed(t, s, v.ID) {
			t.Fatalf("moving into non-book folder %s indexed sections", tc.folder.Title)
		}
	}
	if n := countRows(t, s, `SELECT count(*) FROM book_outline_versions`); n != 0 {
		t.Fatalf("book_outline_versions rows = %d, want 0", n)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, private.ID, "doc_missing"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("moving a missing document err = %v, want ErrNotFound", err)
	}
}

func TestMoveBetweenTwoBookFoldersFillsOnlyTarget(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, fa, a := bookFixture(t, s, planned("Refund Flows"))
	fb, err := s.CreateFolder(ctx, owner, "Book B", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	b, err := s.CreateBook(ctx, fb.ID, planned("Refund Flows"), owner)
	if err != nil {
		t.Fatalf("CreateBook B: %v", err)
	}
	doc, _, err := s.CreateDocument(ctx, owner, "Refund Flows", []byte(`<p>x</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, fa.ID, doc.ID); err != nil {
		t.Fatalf("move into A: %v", err)
	}
	if got := mustGetBook(t, s, a.ID); got.Outline.Parts[0].Chapters[0].Doc != doc.ID {
		t.Fatalf("A outline = %+v, want chapter 1 filled", got.Outline)
	}
	if got := mustGetBook(t, s, b.ID); got.OutlineNumber != 1 || got.Outline.Parts[0].Chapters[0].Planned != "Refund Flows" {
		t.Fatalf("B outline = %+v (number %d), want untouched", got.Outline, got.OutlineNumber)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, fb.ID, doc.ID); err != nil {
		t.Fatalf("move into B: %v", err)
	}
	gotB := mustGetBook(t, s, b.ID)
	if gotB.Outline.Parts[0].Chapters[0].Doc != doc.ID || gotB.OutlineNumber != 2 {
		t.Fatalf("B outline = %+v (number %d), want chapter 1 filled at version 2", gotB.Outline, gotB.OutlineNumber)
	}
	gotA := mustGetBook(t, s, a.ID)
	for _, id := range books.DocIDs(gotA.Outline) {
		if id == doc.ID {
			t.Fatalf("A outline still lists %s after the move out: %+v", doc.ID, gotA.Outline)
		}
	}
	if gotA.OutlineNumber != 3 {
		t.Fatalf("A outline number = %d, want 3 (create, fill, removal)", gotA.OutlineNumber)
	}
	if vs := mustOutlineVersions(t, s, a.ID); vs[0].ChangeNote != "Chapter 1 removed: moved out" {
		t.Fatalf("A removal note = %q", vs[0].ChangeNote)
	}
}

// TestPublishSucceedsWhenSectionsCannotBeParsed: section indexing never blocks
// a publish. Malformed or empty HTML still gets a version, marked indexed.
func TestPublishSucceedsWhenSectionsCannotBeParsed(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, _ := bookFixture(t, s, planned())
	for _, body := range []string{"<h2><", "", "<h2>caf\xe9\x00</h2><p>\xff ok</p>"} {
		doc, v1, err := s.CreateDocument(ctx, owner, "Malformed", []byte(body))
		if err != nil {
			t.Fatalf("CreateDocument(%q): %v", body, err)
		}
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
		v2, err := s.CreateVersion(ctx, doc.ID, v1.ID, "again", []byte(body), owner)
		if err != nil {
			t.Fatalf("CreateVersion(%q): %v", body, err)
		}
		if !sectionsIndexed(t, s, v2.ID) {
			t.Fatalf("CreateVersion(%q) left the version unindexed", body)
		}
		secs, err := s.ListVersionSections(ctx, v2.ID)
		if err != nil || len(secs) > 1 {
			t.Fatalf("ListVersionSections(%q) = %+v, %v; want 0 or 1 rows", body, secs, err)
		}
		if err := s.EnsureVersionSections(ctx, v1.ID); err != nil {
			t.Fatalf("EnsureVersionSections(%q): %v", body, err)
		}
		if !sectionsIndexed(t, s, v1.ID) {
			t.Fatalf("EnsureVersionSections(%q) left the version unindexed", body)
		}
	}
}

func TestDeleteBookCascadesState(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, b := bookFixture(t, s, planned("Intro"))
	doc, v, err := s.CreateDocument(ctx, owner, "Intro", []byte(`<p>x</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder: %v", err)
	}
	if _, err := s.Pool().Exec(ctx, `INSERT INTO reading_positions(user_id,book_id,device_id,document_id,version_id,progression,client_ts)
		VALUES($1,$2,'device-0001',$3,$4,0.5,now())`, owner.ID, b.ID, doc.ID, v.ID); err != nil {
		t.Fatalf("insert reading_positions: %v", err)
	}
	if err := s.DeleteBook(ctx, b.ID); err != nil {
		t.Fatalf("DeleteBook: %v", err)
	}
	if n := countRows(t, s, `SELECT count(*) FROM reading_positions WHERE book_id=$1`, b.ID); n != 0 {
		t.Fatalf("reading_positions rows = %d, want 0", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM book_outline_versions WHERE book_id=$1`, b.ID); n != 0 {
		t.Fatalf("book_outline_versions rows = %d, want 0", n)
	}
	if _, err := s.GetBook(ctx, b.ID); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("GetBook after delete err = %v, want ErrNotFound", err)
	}
	if _, err := s.GetFolder(ctx, f.ID); err != nil {
		t.Fatalf("folder gone after DeleteBook: %v", err)
	}
	if got, err := s.GetDocument(ctx, doc.ID); err != nil || got.ParentFolderID != f.ID {
		t.Fatalf("document after DeleteBook = %+v, %v; want still in folder", got, err)
	}
}

// TestEnsureVersionSectionsIndexesOnDemand: a version published before Book
// mode has no sections until the backfill; reads must not wait for it.
func TestEnsureVersionSectionsIndexesOnDemand(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, err := s.EnsureUserByEmail(ctx, "ensure@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	_, v, err := s.CreateDocument(ctx, owner, "A", []byte(`<h2 id="k">K</h2><p>a b</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.Pool().Exec(ctx, `DELETE FROM version_sections; UPDATE versions SET sections_indexed=false`); err != nil {
		t.Fatalf("reset sections: %v", err)
	}
	if err := s.EnsureVersionSections(ctx, v.ID); err != nil {
		t.Fatalf("EnsureVersionSections: %v", err)
	}
	secs, err := s.ListVersionSections(ctx, v.ID)
	if err != nil || len(secs) != 1 || secs[0].ID != "k" || secs[0].Words != 2 {
		t.Fatalf("ListVersionSections = %+v, %v; want one section k", secs, err)
	}
	if err := s.EnsureVersionSections(ctx, v.ID); err != nil { // idempotent: no duplicate rows
		t.Fatalf("second EnsureVersionSections: %v", err)
	}
	if secs, _ := s.ListVersionSections(ctx, v.ID); len(secs) != 1 {
		t.Fatalf("sections after second ensure = %d, want 1", len(secs))
	}
	if err := s.EnsureVersionSections(ctx, "ver_missing"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("EnsureVersionSections(missing) err = %v, want ErrNotFound", err)
	}
}

func TestIndexVersionSectionsBackfills(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, _ := bookFixture(t, s, planned())
	_, outside, err := s.CreateDocument(ctx, owner, "Outside", []byte(`<p>a b</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	doc, v, err := s.CreateDocument(ctx, owner, "A", []byte(`<p>a b</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder: %v", err)
	}
	if _, err := s.Pool().Exec(ctx, `DELETE FROM version_sections; UPDATE versions SET sections_indexed=false`); err != nil {
		t.Fatalf("reset sections: %v", err)
	}
	n, err := s.IndexVersionSections(ctx)
	if err != nil || n != 1 {
		t.Fatalf("IndexVersionSections = %d, %v; want 1", n, err)
	}
	if secs, err := s.ListVersionSections(ctx, v.ID); err != nil || len(secs) != 1 {
		t.Fatalf("ListVersionSections = %+v, %v; want 1 section", secs, err)
	}
	// A12: the backfill skips documents outside book folders.
	if sectionsIndexed(t, s, outside.ID) {
		t.Fatal("backfill indexed a version outside a book folder")
	}
	if n, err := s.IndexVersionSections(ctx); err != nil || n != 0 {
		t.Fatalf("second IndexVersionSections = %d, %v; want 0", n, err)
	}
}

// TestConcurrentFillAndPush (A8): a placeholder fill (via move) and an outline
// push race on the book row lock. Neither may hit a unique violation; the push
// either conflicts with the fill or both apply in sequence.
func TestConcurrentFillAndPush(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, b := bookFixture(t, s, planned("Refund Flows"))
	doc, _, err := s.CreateDocument(ctx, owner, "Refund Flows", []byte(`<p>x</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	blocker, err := s.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(ctx) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM books WHERE id=$1 FOR UPDATE`, b.ID); err != nil {
		t.Fatal(err)
	}
	moveErr, pushErr := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID)
		moveErr <- err
	}()
	pushed := planned("Refund Flows")
	pushed.Title = "Renamed"
	go func() {
		_, err := s.PushOutline(ctx, b.ID, b.OutlineVersionID, pushed, "rename", owner)
		pushErr <- err
	}()
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	waitErr := waitForLockWaiters(waitCtx, s.Pool(), 2)
	cancel()
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if waitErr != nil {
		t.Fatalf("fill and push did not both wait on the book lock: %v", waitErr)
	}
	recv := func(ch chan error, what string) error {
		select {
		case err := <-ch:
			return err
		case <-time.After(5 * time.Second):
			t.Fatalf("%s did not finish", what)
			return nil
		}
	}
	if err := recv(moveErr, "move"); err != nil {
		t.Fatalf("MoveDocumentToFolder: %v", err)
	}
	err = recv(pushErr, "push")
	got := mustGetBook(t, s, b.ID)
	if got.Outline.Parts[0].Chapters[0].Doc != doc.ID {
		t.Fatalf("outline = %+v, want chapter 1 filled", got.Outline)
	}
	var ce *repo.OutlineConflictError
	switch {
	case err == nil:
		// Push first, then the fill on top of it.
		if got.OutlineNumber != 3 || got.Outline.Title != "Renamed" {
			t.Fatalf("book = %+v, want version 3 titled Renamed", got)
		}
	case errors.As(err, &ce):
		// Fill first; the push's base is stale.
		if got.OutlineNumber != 2 || ce.CurrentVersionID != got.OutlineVersionID {
			t.Fatalf("book = %+v, conflict current %q; want version 2", got, ce.CurrentVersionID)
		}
	default:
		t.Fatalf("PushOutline: %v, want nil or *OutlineConflictError", err)
	}
}

func TestDeleteChapterWritesOutlineVersion(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, b := bookFixture(t, s, planned("One", "Two"))
	one, _, err := s.CreateDocument(ctx, owner, "One", []byte(`<p>1</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	two, _, err := s.CreateDocument(ctx, owner, "Two", []byte(`<p>2</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	for _, d := range []repo.Document{one, two} {
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, d.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
	}
	before := mustGetBook(t, s, b.ID).OutlineNumber
	if err := s.DeleteDocument(ctx, two.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	got := mustGetBook(t, s, b.ID)
	if got.OutlineNumber != before+1 {
		t.Fatalf("outline number = %d, want %d", got.OutlineNumber, before+1)
	}
	if ids := books.DocIDs(got.Outline); len(ids) != 1 || ids[0] != one.ID {
		t.Fatalf("outline docs = %v, want only %s", ids, one.ID)
	}
	if _, removed := books.Prune(got.Outline, map[string]bool{one.ID: true}); len(removed) != 0 {
		t.Fatalf("read-time Prune found %v, want nothing", removed)
	}
	vs := mustOutlineVersions(t, s, b.ID)
	if vs[0].ChangeNote != "Chapter 2 removed: document deleted" || vs[0].CreatedBy.ID != "system" {
		t.Fatalf("removal version = %+v", vs[0])
	}
	// Deleting a document that is not in any book writes nothing.
	loose, _, err := s.CreateDocument(ctx, owner, "Loose", []byte(`<p>x</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if err := s.DeleteDocument(ctx, loose.ID); err != nil {
		t.Fatalf("DeleteDocument(loose): %v", err)
	}
	if n := len(mustOutlineVersions(t, s, b.ID)); n != len(vs) {
		t.Fatalf("outline versions = %d after deleting a loose document, want %d", n, len(vs))
	}
}

func TestMoveOutWritesOutlineVersionAndMoveBackDoesNotResurrect(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, b := bookFixture(t, s, planned("Refund Flows", "Payouts"))
	other, err := s.CreateFolder(ctx, owner, "Elsewhere", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	refunds, _, err := s.CreateDocument(ctx, owner, "Refund Flows", []byte(`<p>x</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	payouts, _, err := s.CreateDocument(ctx, owner, "Payouts", []byte(`<p>y</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	for _, d := range []repo.Document{refunds, payouts} {
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, d.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
	}
	// Out to the root.
	if err := s.MoveDocumentToRoot(ctx, f.ID, refunds.ID); err != nil {
		t.Fatalf("MoveDocumentToRoot: %v", err)
	}
	if vs := mustOutlineVersions(t, s, b.ID); vs[0].ChangeNote != "Chapter 1 removed: moved out" {
		t.Fatalf("root move note = %q", vs[0].ChangeNote)
	}
	// Out to another (non-book) folder; Payouts is now chapter 1.
	if _, err := s.MoveDocumentToFolder(ctx, owner, other.ID, payouts.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder(out): %v", err)
	}
	if vs := mustOutlineVersions(t, s, b.ID); vs[0].ChangeNote != "Chapter 1 removed: moved out" {
		t.Fatalf("folder move note = %q", vs[0].ChangeNote)
	}
	got := mustGetBook(t, s, b.ID)
	if ids := books.DocIDs(got.Outline); len(ids) != 0 {
		t.Fatalf("outline docs after moving both out = %v, want none", ids)
	}
	before := got.OutlineNumber
	// Moving them back finds no placeholder, so neither returns to the outline.
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, refunds.ID); err != nil {
		t.Fatalf("move back: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, payouts.ID); err != nil {
		t.Fatalf("move back: %v", err)
	}
	got = mustGetBook(t, s, b.ID)
	if ids := books.DocIDs(got.Outline); len(ids) != 0 || got.OutlineNumber != before {
		t.Fatalf("outline after moving back = %v (number %d), want unchanged at %d", ids, got.OutlineNumber, before)
	}
	// A root move from a folder the document is not in changes nothing.
	if err := s.MoveDocumentToRoot(ctx, other.ID, refunds.ID); err != nil {
		t.Fatalf("MoveDocumentToRoot(wrong folder): %v", err)
	}
	if d, err := s.GetDocument(ctx, refunds.ID); err != nil || d.ParentFolderID != f.ID {
		t.Fatalf("document = %+v, %v; want still in the book folder", d, err)
	}
}

func TestRemovingFrontAndBackMatterNotes(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, err := s.EnsureUserByEmail(ctx, "matter@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	preface, _, err := s.CreateDocument(ctx, owner, "Preface", []byte(`<p>p</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	glossary, _, err := s.CreateDocument(ctx, owner, "Glossary", []byte(`<p>g</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	for _, d := range []repo.Document{preface, glossary} {
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, d.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
	}
	b, err := s.CreateBook(ctx, f.ID, books.Outline{
		Title: "Book", Front: []books.Entry{{Doc: preface.ID}},
		Parts: []books.Part{{Chapters: []books.Entry{}}}, Back: []books.Entry{{Doc: glossary.ID}},
	}, owner)
	if err != nil {
		t.Fatalf("CreateBook: %v", err)
	}
	if err := s.DeleteDocument(ctx, preface.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	if vs := mustOutlineVersions(t, s, b.ID); vs[0].ChangeNote != "Front matter removed: document deleted" {
		t.Fatalf("front note = %q", vs[0].ChangeNote)
	}
	if err := s.MoveDocumentToRoot(ctx, f.ID, glossary.ID); err != nil {
		t.Fatalf("MoveDocumentToRoot: %v", err)
	}
	if vs := mustOutlineVersions(t, s, b.ID); vs[0].ChangeNote != "Back matter removed: moved out" {
		t.Fatalf("back note = %q", vs[0].ChangeNote)
	}
	got := mustGetBook(t, s, b.ID)
	if len(got.Outline.Front) != 0 || len(got.Outline.Back) != 0 || got.OutlineNumber != 3 {
		t.Fatalf("outline = %+v (number %d), want empty front and back at version 3", got.Outline, got.OutlineNumber)
	}
}

func TestCreateBookIndexesPlacedChapters(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, err := s.EnsureUserByEmail(ctx, "create-book@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	placed, pv, err := s.CreateDocument(ctx, owner, "01 · Placed", []byte(`<h2>A</h2><p>a</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	unplaced, uv, err := s.CreateDocument(ctx, owner, "Unplaced", []byte(`<h2>B</h2><p>b</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	for _, d := range []repo.Document{placed, unplaced} {
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, d.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
	}
	if _, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "Book", Parts: []books.Part{{Chapters: []books.Entry{{Doc: placed.ID}}}}}, owner); err != nil {
		t.Fatalf("CreateBook: %v", err)
	}
	if !sectionsIndexed(t, s, pv.ID) {
		t.Fatal("CreateBook did not index the placed chapter")
	}
	if sectionsIndexed(t, s, uv.ID) {
		t.Fatal("CreateBook indexed a document it did not place")
	}
}

// TestPublishOutsideBookDoesNotIndex (A12): sections are indexed only for
// documents in book folders.
func TestPublishOutsideBookDoesNotIndex(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, err := s.EnsureUserByEmail(ctx, "outside@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	folder, err := s.CreateFolder(ctx, owner, "Plain", "")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	doc, v1, err := s.CreateDocument(ctx, owner, "A", []byte(`<h2>X</h2><p>a</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	v2, err := s.CreateVersion(ctx, doc.ID, v1.ID, "root", []byte(`<h2>X</h2><p>a b</p>`), owner)
	if err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, folder.ID, doc.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder: %v", err)
	}
	v3, err := s.CreateVersion(ctx, doc.ID, v2.ID, "folder", []byte(`<h2>X</h2><p>a b c</p>`), owner)
	if err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}
	for _, id := range []string{v1.ID, v2.ID, v3.ID} {
		if sectionsIndexed(t, s, id) {
			t.Fatalf("version %s outside a book is indexed", id)
		}
	}
	if n := countRows(t, s, `SELECT count(*) FROM version_sections`); n != 0 {
		t.Fatalf("version_sections rows = %d, want 0", n)
	}
}

func TestPublishInBookIndexes(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, _ := bookFixture(t, s, planned())
	doc, v1, err := s.CreateDocument(ctx, owner, "Not planned", []byte(`<h2>X</h2><p>a</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder: %v", err)
	}
	v2, err := s.CreateVersion(ctx, doc.ID, v1.ID, "in book", []byte(`<h2>X</h2><p>a b</p><h2>Y</h2><p>c</p>`), owner)
	if err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}
	if !sectionsIndexed(t, s, v2.ID) {
		t.Fatal("publish in a book folder did not index sections")
	}
	secs, err := s.ListVersionSections(ctx, v2.ID)
	if err != nil || len(secs) != 2 || secs[1].Title != "Y" || secs[1].Order != 1 {
		t.Fatalf("ListVersionSections = %+v, %v; want X and Y", secs, err)
	}
}
