package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
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

// failingBlobs fails Get for the blobs of chosen documents, as a transient
// S3 error would.
type failingBlobs struct {
	blob.Store
	mu   sync.Mutex
	docs map[string]bool
}

func (f *failingBlobs) failDoc(docID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.docs[docID] = true
}

func (f *failingBlobs) Get(ctx context.Context, key string) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id := range f.docs {
		if strings.HasPrefix(key, "docs/"+id+"/") {
			return nil, "", errors.New("s3 unavailable")
		}
	}
	return f.Store.Get(ctx, key)
}

func newFailingBlobStore(t *testing.T) (*Store, *failingBlobs, auth.Principal) {
	t.Helper()
	ctx := context.Background()
	fb := &failingBlobs{Store: blob.NewMemory(), docs: map[string]bool{}}
	s, err := ConnectWithBlob(ctx, testdb.New(t), fb)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	owner, err := s.EnsureUserByEmail(ctx, "failing-blobs@example.com")
	if err != nil {
		t.Fatal(err)
	}
	return s, fb, owner
}

func versionIndexed(t *testing.T, s *Store, versionID string) bool {
	t.Helper()
	var ok bool
	if err := s.Pool().QueryRow(context.Background(), `SELECT sections_indexed FROM versions WHERE id=$1`, versionID).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

// A fill indexes the chapter best-effort after commit: a blob read failure
// still moves the document and fills the placeholder.
func TestFillWithFailingBlobStillMoves(t *testing.T) {
	ctx := context.Background()
	s, fb, owner := newFailingBlobStore(t)
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "Book", Parts: []books.Part{{Chapters: []books.Entry{{Planned: "Refunds"}}}}}, owner)
	if err != nil {
		t.Fatal(err)
	}
	doc, v, err := s.CreateDocument(ctx, owner, "Refunds", []byte(`<h2>A</h2><p>a</p>`))
	if err != nil {
		t.Fatal(err)
	}
	fb.failDoc(doc.ID)
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatalf("MoveDocumentToFolder with a failing blob: %v", err)
	}
	got, err := s.GetBook(ctx, b.ID)
	if err != nil || got.Outline.Parts[0].Chapters[0].Doc != doc.ID {
		t.Fatalf("book = %+v, %v; want chapter 1 filled", got, err)
	}
	if d, err := s.GetDocument(ctx, doc.ID); err != nil || d.ParentFolderID != f.ID {
		t.Fatalf("document = %+v, %v; want moved", d, err)
	}
	if versionIndexed(t, s, v.ID) {
		t.Fatal("version indexed although its blob could not be read")
	}
}

// CreateBook indexes placed chapters best-effort after commit.
func TestCreateBookWithFailingBlobStillCreates(t *testing.T) {
	ctx := context.Background()
	s, fb, owner := newFailingBlobStore(t)
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatal(err)
	}
	bad, bv, err := s.CreateDocument(ctx, owner, "01 · Bad", []byte(`<h2>A</h2><p>a</p>`))
	if err != nil {
		t.Fatal(err)
	}
	good, gv, err := s.CreateDocument(ctx, owner, "02 · Good", []byte(`<h2>B</h2><p>b</p>`))
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{bad.ID, good.ID} {
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	fb.failDoc(bad.ID)
	b, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "Book", Parts: []books.Part{{Chapters: []books.Entry{{Doc: bad.ID}, {Doc: good.ID}}}}}, owner)
	if err != nil {
		t.Fatalf("CreateBook with a failing blob: %v", err)
	}
	if b.OutlineNumber != 1 || len(books.DocIDs(b.Outline)) != 2 {
		t.Fatalf("book = %+v, want version 1 with both chapters", b)
	}
	if versionIndexed(t, s, bv.ID) {
		t.Fatal("bad chapter indexed although its blob could not be read")
	}
	if !versionIndexed(t, s, gv.ID) {
		t.Fatal("good chapter not indexed")
	}
}

// The backfill skips a version whose blob cannot be read or whose sections
// cannot be inserted, and indexes the rest. Not parallel: it replaces
// splitSections.
func TestBackfillSkipsFailingVersions(t *testing.T) {
	ctx := context.Background()
	s, fb, owner := newFailingBlobStore(t)
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "Book"}, owner); err != nil {
		t.Fatal(err)
	}
	versions := map[string]string{}
	for _, name := range []string{"good", "badinsert", "badblob"} {
		d, v, err := s.CreateDocument(ctx, owner, name, []byte(`<h2>`+name+`</h2><p>x</p>`))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, d.ID); err != nil {
			t.Fatal(err)
		}
		if name == "badblob" {
			fb.failDoc(d.ID)
		}
		versions[name] = v.ID
	}
	t.Cleanup(func() { splitSections = render.Sections })
	splitSections = func(html []byte) ([]render.Section, error) {
		if strings.Contains(string(html), "badinsert") {
			return []render.Section{{Title: "x", Words: -1}}, nil // violates words >= 0
		}
		return render.Sections(html)
	}
	n, err := s.IndexVersionSections(ctx)
	if err != nil || n != 1 {
		t.Fatalf("IndexVersionSections = %d, %v; want 1, nil", n, err)
	}
	if !versionIndexed(t, s, versions["good"]) || versionIndexed(t, s, versions["badinsert"]) || versionIndexed(t, s, versions["badblob"]) {
		t.Fatal("want only the good version indexed")
	}
}
