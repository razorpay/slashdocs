package postgres_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/blob"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/internal/textedit"
)

// hookedBlobs is a blob store that runs a hook before each Put and Get of
// the store under it.
type hookedBlobs struct {
	blob.Store
	mu       sync.Mutex
	put, get func(key string)
}

func (h *hookedBlobs) Put(ctx context.Context, key, contentType string, body []byte) error {
	h.run(h.put, key)
	return h.Store.Put(ctx, key, contentType, body)
}

func (h *hookedBlobs) Get(ctx context.Context, key string) ([]byte, string, error) {
	h.run(h.get, key)
	return h.Store.Get(ctx, key)
}

func (h *hookedBlobs) run(hook func(string), key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if hook != nil {
		hook(key)
	}
}

// hooked returns a server whose blob store runs hooks, and a server on the
// same database and blobs with no hooks.
func hooked(t *testing.T) (*pgrepo.Store, *hookedBlobs, *pgrepo.Store) {
	t.Helper()
	plain, _, blobs := servers(t)
	h := &hookedBlobs{Store: blobs}
	return pgrepo.NewWithBlob(plain.Pool(), h), h, plain
}

// A push writes its blobs before it takes the lock of the document, so a
// person types while the blobs are written. The push then sees the
// operation, does its work again, and keeps the typed text.
func TestAPersonTypesWhileAPushWritesItsBlobs(t *testing.T) {
	ctx := context.Background()
	pusher, blobs, typist := hooked(t)
	doc, _, err := typist.CreateDocument(ctx, liveOwner, "Push", "", []byte("<p>one</p><p>two</p>"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := typist.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " A"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	typed := make(chan error, 1)
	blobs.put = func(string) {
		blobs.put = nil
		go func() {
			_, err := typist.AppendOperation(ctx, doc.ID, insert(2, "op_2", 8, " B"), liveOther)
			typed <- err
		}()
		select {
		case err := <-typed:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("the operation waited for the blob of the push")
		}
	}
	seq := first.Seq
	pushed, onto, err := pusher.SaveVersion(ctx, doc.ID, first.VersionID, &seq, liveOwner, repo.Upload([]byte("<p>one A</p><p>TWO</p>"), "Two"))
	if err != nil || !onto.Rebased {
		t.Fatalf("push = %+v on %+v, %v; want a merge", pushed, onto, err)
	}
	if got, err := typist.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>one A B</p><p>TWO</p>" {
		t.Fatalf("pushed version = %q, %v; want the typed text and the push", got, err)
	}
	if v, err := typist.GetVersion(ctx, first.VersionID); err != nil || v.Open || v.Seq != 3 {
		t.Fatalf("the sitting = %+v, %v; want it sealed at seq 3, with the late operation", v, err)
	}
}

// The background task makes the seal of an idle version before it takes the
// lock. An operation that comes in that time is not in the search for idle
// versions, so with the lock the task makes sure again that the version is
// idle.
func TestTheTaskDoesNotSealAVersionThatGotAnOperationDuringItsSearch(t *testing.T) {
	ctx := context.Background()
	sealer, blobs, typist := hooked(t)
	doc, _, err := typist.CreateDocument(ctx, liveOwner, "Idle", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	op, err := typist.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, typist, `UPDATE document_ops SET created_at = now() - interval '11 minutes' WHERE document_id = '`+doc.ID+`'`)
	// The last operation is new for the lock, and not for the search.
	blobs.put = func(string) {
		exec(t, typist, `UPDATE document_ops SET created_at = now() WHERE document_id = '`+doc.ID+`'`)
	}
	if sealed, err := sealer.SealIdleVersions(ctx); err != nil || sealed != 0 {
		t.Fatalf("sealed %d, %v; want none", sealed, err)
	}
	if v, err := typist.GetVersion(ctx, op.VersionID); err != nil || !v.Open {
		t.Fatalf("version = %+v, %v; want open", v, err)
	}
}

// A sitting that ends on the text where it started makes the version before
// the current one again. Its approvals count again, and the approval event
// says so.
func TestADiscardedSittingSendsTheApprovalStatusBack(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	store.EnableApprovalEvents("https://docs.example.com")
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Approved", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateApprovalRequest(ctx, doc.ID, liveOther, liveOwner); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.CreateOrUpdateApproval(ctx, doc.ID, v1.ID, nil, repo.DecisionApproved, "", liveOther); err != nil {
		t.Fatal(err)
	}
	last := func() string {
		t.Helper()
		return text(t, store, `SELECT p->>'type' || ' ' || (p->>'status') FROM (SELECT payload::jsonb AS p FROM approval_event_outbox) e ORDER BY (p->>'sequence')::bigint DESC LIMIT 1`)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner); err != nil {
		t.Fatal(err)
	}
	if got := last(); got != repo.ApprovalEventVersionCreated+" pending" {
		t.Fatalf("event = %q, want a new version that is pending", got)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 2, ClientOpID: "op_2", Replacements: []textedit.Replacement{{Start: 6, End: 10, OldHTML: " two"}}}, liveOwner); err != nil {
		t.Fatal(err)
	}
	sealIdle(t, store, doc.ID)
	if got := last(); got != repo.ApprovalEventVersionCreated+" approved" {
		t.Fatalf("event = %q, want the version before, approved", got)
	}
}

// A reader comments on the open version while the sitting ends on the text
// where it started. The comment goes to the version before, and the seal
// does not fail.
func TestACommentDuringTheDiscardOfASittingMovesToTheVersionBefore(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Undo", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 2, ClientOpID: "op_2", Replacements: []textedit.Replacement{{Start: 6, End: 10, OldHTML: " two"}}}, liveOther); err != nil {
		t.Fatal(err)
	}
	exec(t, store, `UPDATE document_ops SET created_at = now() - interval '11 minutes' WHERE document_id = '`+doc.ID+`'`)

	// The comment is written, and not committed yet.
	comment, err := store.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = comment.Rollback(ctx) }()
	if _, err := comment.Exec(ctx, `INSERT INTO comments(id,document_id,created_on_version_id,author_type,author_id,body,selected_text,anchor_json,root_comment_id)
		VALUES('cmt_late',$1,$2,'user','usr_reader','A note','one','{}','cmt_late')`, doc.ID, typed.VersionID); err != nil {
		t.Fatal(err)
	}
	sealed := make(chan int, 1)
	go func() {
		n, _ := store.SealIdleVersions(ctx)
		sealed <- n
	}()
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := waitForLockWaiters(waitCtx, store.Pool(), 1); err != nil {
		t.Fatalf("the seal did not wait for the comment: %v", err)
	}
	if err := comment.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if n := <-sealed; n != 1 {
		t.Fatalf("sealed %d versions, want 1", n)
	}
	if got := text(t, store, `SELECT created_on_version_id FROM comments WHERE id = 'cmt_late'`); got != v1.ID {
		t.Fatalf("the comment is on version %s, want %s", got, v1.ID)
	}
}

// A reader comments on the open version while a discard removes it. The
// comment waits for the discard, and then finds no version: the version is
// not found, and the write does not fail on the reference to it.
func TestACommentAfterTheDiscardOfItsVersionFindsNoVersion(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Undo", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	discard, err := store.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = discard.Rollback(ctx) }()
	q := dbsqlc.New(discard)
	if err := q.LockVersion(ctx, typed.VersionID); err != nil {
		t.Fatal(err)
	}
	commented := make(chan error, 1)
	go func() {
		_, err := store.CreateComment(ctx, doc.ID, typed.VersionID, "A note", repo.Anchor{Quote: "one"}, 0, liveOther, nil)
		commented <- err
	}()
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := waitForLockWaiters(waitCtx, store.Pool(), 1); err != nil {
		t.Fatalf("the comment did not wait for the discard: %v", err)
	}
	if err := q.DiscardOpenVersion(ctx, dbsqlc.DiscardOpenVersionParams{ID: typed.VersionID, ParentVersionID: v1.ID}); err != nil {
		t.Fatal(err)
	}
	if err := discard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-commented; !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("comment = %v, want %v", err, repo.ErrNotFound)
	}
}

// A seal or a snapshot deletes the blob that a read without a lock is about
// to read. The read goes again while the version moves, and a blob that is
// gone while the version still names it is an error, not a document that is
// gone.
func TestAReadDuringSealsIsNotADocumentThatIsGone(t *testing.T) {
	ctx := context.Background()
	reader, blobs, writer := hooked(t)
	doc, _, err := writer.CreateDocument(ctx, liveOwner, "Moves", "", []byte("<p>0</p>"))
	if err != nil {
		t.Fatal(err)
	}
	// Two writes come during the reads, and each one deletes the blob that
	// the read was about to get.
	writes := 0
	blobs.get = func(key string) {
		if writes++; writes > 2 {
			return
		}
		if _, _, err := writer.SaveVersion(ctx, doc.ID, "", nil, liveOwner, repo.Upload([]byte("<p>"+key+"</p>"), "")); err != nil {
			t.Error(err)
		}
		if err := blobs.Delete(ctx, key); err != nil {
			t.Error(err)
		}
	}
	if _, _, err := reader.LiveChangeSummary(ctx, doc.ID); err != nil {
		t.Fatalf("read during two seals: %v", err)
	}

	// A server with no cache reads the blob of the current version, which
	// is gone.
	blobs.get = func(key string) { _ = blobs.Delete(ctx, key) }
	d, err := writer.GetDocument(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pgrepo.NewWithBlob(writer.Pool(), blobs).GetVersionHTML(ctx, d.CurrentVersionID); err == nil || errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("a blob of the current version that is gone: err = %v, want an error that is not %v", err, repo.ErrNotFound)
	}
}

// A person who is not an approver cannot start the seal of the open
// version: the decision is refused before it writes a blob.
func TestADecisionOfAPersonWhoIsNotAnApproverWritesNoBlob(t *testing.T) {
	ctx := context.Background()
	decider, blobs, store := hooked(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Open", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner)
	if err != nil {
		t.Fatal(err)
	}
	blobs.put = func(key string) { t.Errorf("the refused decision wrote the blob %s", key) }
	if _, _, err := decider.CreateOrUpdateApproval(ctx, doc.ID, typed.VersionID, nil, repo.DecisionApproved, "", liveOther); !errors.Is(err, repo.ErrForbidden) {
		t.Fatalf("decision = %v, want %v", err, repo.ErrForbidden)
	}
	if v, err := store.GetVersion(ctx, typed.VersionID); err != nil || !v.Open {
		t.Fatalf("version = %+v, %v; want it still open", v, err)
	}
}
