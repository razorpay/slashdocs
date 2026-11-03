package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/books"
	"github.com/razorpay/slashdocs/api/internal/testdb"
	"github.com/razorpay/slashdocs/internal/render"
)

// TestPublishSectionFailuresNeverBlockPublish covers the two failure paths
// that real HTML cannot reach: a split error marks the version indexed with
// no rows, and a failed insert rolls back to the savepoint and leaves the
// version unindexed for EnsureVersionSections. Not parallel: it replaces
// splitSections.
func TestPublishSectionFailuresNeverBlockPublish(t *testing.T) {
	ctx := context.Background()
	s, err := Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	owner, err := s.EnsureUserByEmail(ctx, "sections-internal@example.com")
	if err != nil {
		t.Fatal(err)
	}
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "Book"}, owner); err != nil {
		t.Fatal(err)
	}
	doc, v, err := s.CreateDocument(ctx, owner, "Doc", []byte(`<h2>A</h2><p>a</p>`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatal(err)
	}
	indexed := func(id string) (bool, int) {
		t.Helper()
		var ok bool
		var n int
		if err := s.Pool().QueryRow(ctx, `SELECT sections_indexed, (SELECT count(*) FROM version_sections WHERE version_id=$1) FROM versions WHERE id=$1`, id).Scan(&ok, &n); err != nil {
			t.Fatal(err)
		}
		return ok, n
	}
	t.Cleanup(func() { splitSections = render.Sections })

	splitSections = func([]byte) ([]render.Section, error) { return nil, errors.New("cannot split") }
	v2, err := s.CreateVersion(ctx, doc.ID, v.ID, "split error", []byte(`<h2>A</h2><p>b</p>`), owner)
	if err != nil {
		t.Fatalf("CreateVersion with a split error: %v", err)
	}
	if ok, n := indexed(v2.ID); !ok || n != 0 {
		t.Fatalf("split error: indexed=%v rows=%d, want indexed with 0 rows", ok, n)
	}

	// words < 0 violates the table's CHECK, so the insert fails.
	splitSections = func([]byte) ([]render.Section, error) { return []render.Section{{Title: "A", Words: -1}}, nil }
	v3, err := s.CreateVersion(ctx, doc.ID, v2.ID, "insert error", []byte(`<h2>A</h2><p>c</p>`), owner)
	if err != nil {
		t.Fatalf("CreateVersion with an insert error: %v", err)
	}
	if ok, n := indexed(v3.ID); ok || n != 0 {
		t.Fatalf("insert error: indexed=%v rows=%d, want unindexed with 0 rows", ok, n)
	}
	if got, err := s.GetDocument(ctx, doc.ID); err != nil || got.CurrentVersionID != v3.ID {
		t.Fatalf("document = %+v, %v; want current version %s", got, err, v3.ID)
	}

	splitSections = render.Sections
	if err := s.EnsureVersionSections(ctx, v3.ID); err != nil {
		t.Fatalf("EnsureVersionSections: %v", err)
	}
	if ok, n := indexed(v3.ID); !ok || n != 1 {
		t.Fatalf("after ensure: indexed=%v rows=%d, want indexed with 1 row", ok, n)
	}
}
