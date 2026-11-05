package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

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

// barrierBlobs holds every Get, once armed, until want Gets are in flight at
// once, and fails a Get that waits longer than a second. A caller that reads
// blobs one at a time never gets past it.
type barrierBlobs struct {
	blob.Store
	mu       sync.Mutex
	armed    bool
	want     int
	inFlight int
	release  chan struct{}
}

func (b *barrierBlobs) arm(want int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.armed, b.want, b.release = true, want, make(chan struct{})
}

func (b *barrierBlobs) Get(ctx context.Context, key string) ([]byte, string, error) {
	b.mu.Lock()
	if !b.armed {
		b.mu.Unlock()
		return b.Store.Get(ctx, key)
	}
	b.inFlight++
	if b.inFlight == b.want {
		close(b.release)
	}
	release := b.release
	b.mu.Unlock()
	select {
	case <-release:
		return b.Store.Get(ctx, key)
	case <-time.After(time.Second):
		return nil, "", errors.New("blob reads were not concurrent")
	}
}

// CreateBook reads the blobs of the chapters it places concurrently, so a
// large "Make this a book" does not pay one blob read per chapter in series.
func TestCreateBookIndexesChaptersConcurrently(t *testing.T) {
	ctx := context.Background()
	bb := &barrierBlobs{Store: blob.NewMemory()}
	s, err := ConnectWithBlob(ctx, testdb.New(t), bb)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	owner, err := s.EnsureUserByEmail(ctx, "concurrent-index@example.com")
	if err != nil {
		t.Fatal(err)
	}
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatal(err)
	}
	var entries []books.Entry
	var versions []string
	for _, title := range []string{"01 · A", "02 · B", "03 · C"} {
		d, v, err := s.CreateDocument(ctx, owner, title, []byte(`<h2>H</h2><p>words</p>`))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, d.ID); err != nil {
			t.Fatal(err)
		}
		entries, versions = append(entries, books.Entry{Doc: d.ID}), append(versions, v.ID)
	}
	bb.arm(min(len(versions), s.indexAfterCommitLimit()))
	if _, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "Book", Parts: []books.Part{{Chapters: entries}}}, owner); err != nil {
		t.Fatalf("CreateBook: %v", err)
	}
	for _, v := range versions {
		if !versionIndexed(t, s, v) {
			t.Errorf("version %s not indexed: CreateBook read its chapters' blobs one at a time", v)
		}
	}
}

// probeBlobs records, on each Get, how many pooled connections are in use and
// whether the version row whose blob is read can be locked by another
// session, so a test can tell whether the reader holds a transaction across
// the blob read.
type probeBlobs struct {
	blob.Store
	pool     interface{ Stat() *pgxpool.Stat }
	tryLock  func(key string) error
	mu       sync.Mutex
	acquired []int32
	lockErrs []error
}

func (p *probeBlobs) Get(ctx context.Context, key string) ([]byte, string, error) {
	if p.tryLock != nil {
		acquired := p.pool.Stat().AcquiredConns()
		err := p.tryLock(key)
		p.mu.Lock()
		p.acquired, p.lockErrs = append(p.acquired, acquired), append(p.lockErrs, err)
		p.mu.Unlock()
	}
	return p.Store.Get(ctx, key)
}

// On-demand indexing reads the version's blob before it opens a transaction,
// so a slow S3 read holds neither a pooled connection nor the version row
// lock that DeleteDocument and other indexers wait on.
func TestEnsureVersionSectionsReadsBlobOutsideTransaction(t *testing.T) {
	ctx := context.Background()
	pb := &probeBlobs{Store: blob.NewMemory()}
	s, err := ConnectWithBlob(ctx, testdb.New(t), pb)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	owner, err := s.EnsureUserByEmail(ctx, "blob-outside-tx@example.com")
	if err != nil {
		t.Fatal(err)
	}
	_, v, err := s.CreateDocument(ctx, owner, "Loose", []byte(`<h2>H</h2><p>words</p>`))
	if err != nil {
		t.Fatal(err)
	}
	if versionIndexed(t, s, v.ID) {
		t.Fatal("a document outside a book was indexed at publish")
	}
	other, err := pgx.Connect(ctx, s.Pool().Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = other.Close(context.Background()) })
	pb.pool = s.Pool()
	pb.tryLock = func(key string) error {
		tx, err := other.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		var id string
		return tx.QueryRow(ctx, `SELECT id FROM versions WHERE html_blob_key=$1 FOR NO KEY UPDATE NOWAIT`, key).Scan(&id)
	}
	if err := s.EnsureVersionSections(ctx, v.ID); err != nil {
		t.Fatalf("EnsureVersionSections: %v", err)
	}
	if !versionIndexed(t, s, v.ID) {
		t.Fatal("version not indexed")
	}
	if len(pb.acquired) != 1 {
		t.Fatalf("blob reads = %d, want 1", len(pb.acquired))
	}
	if pb.acquired[0] != 0 {
		t.Errorf("pooled connections in use during the blob read = %d, want 0", pb.acquired[0])
	}
	if pb.lockErrs[0] != nil {
		t.Errorf("version row was locked during the blob read: %v", pb.lockErrs[0])
	}
	// An indexed version is not read again.
	if err := s.EnsureVersionSections(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if len(pb.acquired) != 1 {
		t.Errorf("an indexed version was read again: %d blob reads", len(pb.acquired))
	}
}

// After-commit indexing runs well below the pool size, so "Make this a book"
// on a large folder leaves connections for every other request.
func TestIndexAfterCommitLimitStaysBelowThePool(t *testing.T) {
	for _, tc := range []struct {
		maxConns int32
		want     int
	}{{1, 1}, {4, 1}, {8, 2}, {16, 4}, {64, 8}} {
		if got := indexLimitFor(tc.maxConns); got != tc.want {
			t.Errorf("indexLimitFor(%d) = %d, want %d", tc.maxConns, got, tc.want)
		}
	}
}
