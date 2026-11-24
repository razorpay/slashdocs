package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
)

var expiryOwner = auth.Principal{Type: auth.PrincipalUser, ID: "usr_expiry", Email: "expiry@example.com", Name: "Owner"}

var onePage = repo.Page{Limit: 25}

// fromNow returns a time that is a number of days from now, in whole
// seconds, as an expiry time is.
func fromNow(days int) time.Time {
	return time.Now().Add(time.Duration(days) * 24 * time.Hour).UTC().Truncate(time.Second)
}

// expiryOf returns the expiry of the document with the ID in docs.
func expiryOf(t *testing.T, docs []repo.Document, id string) string {
	t.Helper()
	for _, d := range docs {
		if d.ID == id {
			return d.ExpiresAt
		}
	}
	t.Fatalf("the list does not hold the document %s", id)
	return ""
}

// expiries returns the expiry of two documents as each read of the store
// gives it: root is at the root with the label temp, and filed is in folder.
func expiries(t *testing.T, store *pgrepo.Store, root, filed repo.Document, folderID string) map[string]string {
	t.Helper()
	ctx := context.Background()
	got := map[string]string{}
	d, err := store.GetDocument(ctx, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	got["GetDocument"] = d.ExpiresAt
	list, _, err := store.ListDocuments(ctx, expiryOwner, onePage, false)
	if err != nil {
		t.Fatal(err)
	}
	got["ListDocuments"] = expiryOf(t, list, root.ID)
	found, _, err := store.SearchDocuments(ctx, expiryOwner, repo.DocumentSearch{Terms: []string{"scratch"}}, false, onePage)
	if err != nil {
		t.Fatal(err)
	}
	got["SearchDocuments"] = expiryOf(t, found, root.ID)
	got["SearchDocuments in a folder"] = expiryOf(t, found, filed.ID)
	labelled, err := store.ListDocumentsByLabel(ctx, expiryOwner, "temp")
	if err != nil {
		t.Fatal(err)
	}
	got["ListDocumentsByLabel"] = expiryOf(t, labelled, root.ID)
	inFolder, err := store.ListFolderDocuments(ctx, expiryOwner, folderID)
	if err != nil {
		t.Fatal(err)
	}
	got["ListFolderDocuments"] = expiryOf(t, inFolder, filed.ID)
	entries, _, _, err := store.ListFolder(ctx, expiryOwner, folderID, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Document != nil && e.Document.ID == filed.ID {
			got["ListFolder"] = e.Document.ExpiresAt
		}
	}
	if _, ok := got["ListFolder"]; !ok {
		t.Fatalf("the folder does not list the document %s", filed.ID)
	}
	return got
}

// twoDocuments makes a document at the root with the label temp, and one in
// a new folder.
func twoDocuments(t *testing.T, store *pgrepo.Store, opts ...repo.DocumentOption) (root, filed repo.Document, folderID string) {
	t.Helper()
	ctx := context.Background()
	folder, err := store.CreateFolder(ctx, expiryOwner, "Temporary", "")
	if err != nil {
		t.Fatal(err)
	}
	root, _, err = store.CreateDocument(ctx, expiryOwner, "Scratch notes", "", []byte("<p>scratch</p>"), opts...)
	if err != nil {
		t.Fatal(err)
	}
	filed, _, err = store.CreateDocument(ctx, expiryOwner, "Scratch report", folder.ID, []byte("<p>scratch</p>"), opts...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplaceDocumentLabels(ctx, root.ID, []string{"temp"}, expiryOwner); err != nil {
		t.Fatal(err)
	}
	return root, filed, folder.ID
}

// Every read that returns a document returns its expiry: a page that shows
// a document from a list shows the mark too.
func TestEveryReadOfADocumentReturnsItsExpiry(t *testing.T) {
	store := newStore(t)
	at := fromNow(7)
	root, filed, folderID := twoDocuments(t, store, repo.WithExpiry(at))
	want := at.Format(time.RFC3339)
	if root.ExpiresAt != want || filed.ExpiresAt != want {
		t.Fatalf("CreateDocument returned the expiry %q and %q, want %q", root.ExpiresAt, filed.ExpiresAt, want)
	}
	for read, got := range expiries(t, store, root, filed, folderID) {
		if got != want {
			t.Errorf("%s returned the expiry %q, want %q", read, got, want)
		}
	}
}

func TestADocumentWithoutAnExpiryHasNone(t *testing.T) {
	store := newStore(t)
	root, filed, folderID := twoDocuments(t, store)
	if root.ExpiresAt != "" {
		t.Fatalf("CreateDocument returned the expiry %q, want none", root.ExpiresAt)
	}
	for read, got := range expiries(t, store, root, filed, folderID) {
		if got != "" {
			t.Errorf("%s returned the expiry %q, want none", read, got)
		}
	}
}

func TestChangeDocumentSetsAndRemovesTheExpiry(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	doc, _, err := store.CreateDocument(ctx, expiryOwner, "Scratch", "", []byte("<p>scratch</p>"))
	if err != nil {
		t.Fatal(err)
	}
	updated := func() string {
		return text(t, store, `SELECT updated_at::text FROM documents WHERE id = $1`, doc.ID)
	}
	before := updated()

	week := fromNow(7)
	got, err := store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{ExpiresAt: &week})
	if err != nil {
		t.Fatal(err)
	}
	if want := week.Format(time.RFC3339); got.ExpiresAt != want || got.Title != "Scratch" {
		t.Fatalf("ChangeDocument returned the expiry %q and the title %q, want %q and Scratch", got.ExpiresAt, got.Title, want)
	}
	// The lists sort by updated_at, and the content did not change.
	if after := updated(); after != before {
		t.Fatalf("a change of the expiry moved updated_at from %s to %s", before, after)
	}

	month := fromNow(30)
	if got, err = store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{ExpiresAt: &month}); err != nil || got.ExpiresAt != month.Format(time.RFC3339) {
		t.Fatalf("ChangeDocument = %q, %v, want %q", got.ExpiresAt, err, month.Format(time.RFC3339))
	}

	title := "Kept"
	if got, err = store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{Title: &title}); err != nil || got.Title != "Kept" || got.ExpiresAt != month.Format(time.RFC3339) {
		t.Fatalf("a change of the title gave %q with the expiry %q, %v", got.Title, got.ExpiresAt, err)
	}

	title, none := "Both", time.Time{}
	if got, err = store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{Title: &title, ExpiresAt: &none}); err != nil || got.Title != "Both" || got.ExpiresAt != "" {
		t.Fatalf("a change of both gave %q with the expiry %q, %v", got.Title, got.ExpiresAt, err)
	}
	if got, err = store.GetDocument(ctx, doc.ID); err != nil || got.ExpiresAt != "" {
		t.Fatalf("GetDocument = %q, %v, want no expiry", got.ExpiresAt, err)
	}
}

// A change that is only for a later time is the change of an editor, who
// cannot delete the document: it never makes the expiry sooner, and gives no
// expiry to a document that has none.
func TestAChangeForLaterOnlyNeverMovesTheExpirySooner(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	doc, _, err := store.CreateDocument(ctx, expiryOwner, "Scratch", "", []byte("<p>scratch</p>"))
	if err != nil {
		t.Fatal(err)
	}
	day, week, month, never := fromNow(1), fromNow(7), fromNow(30), time.Time{}
	later := func(at time.Time) (repo.Document, error) {
		return store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{ExpiresAt: &at, OnlyLater: true})
	}
	if _, err := later(week); !errors.Is(err, repo.ErrExpiryNotLater) {
		t.Fatalf("an expiry for a document that has none: %v, want ErrExpiryNotLater", err)
	}
	if _, err := store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{ExpiresAt: &week}); err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{day, week} {
		if _, err := later(at); !errors.Is(err, repo.ErrExpiryNotLater) {
			t.Fatalf("a change to %s: %v, want ErrExpiryNotLater", at, err)
		}
	}
	title := "Mine"
	if _, err := store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{Title: &title, ExpiresAt: &day, OnlyLater: true}); !errors.Is(err, repo.ErrExpiryNotLater) {
		t.Fatalf("a rename with a sooner expiry: %v", err)
	}
	if got, err := store.GetDocument(ctx, doc.ID); err != nil || got.ExpiresAt != week.Format(time.RFC3339) || got.Title != "Scratch" {
		t.Fatalf("after the refused changes the document is %q, %q, %v", got.Title, got.ExpiresAt, err)
	}
	if got, err := later(month); err != nil || got.ExpiresAt != month.Format(time.RFC3339) {
		t.Fatalf("a later expiry = %q, %v", got.ExpiresAt, err)
	}
	if got, err := later(never); err != nil || got.ExpiresAt != "" {
		t.Fatalf("no expiry = %q, %v", got.ExpiresAt, err)
	}
	if _, err := store.ChangeDocument(ctx, "doc_none", repo.DocumentChange{ExpiresAt: &month, OnlyLater: true}); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("a change of no document: %v, want ErrNotFound", err)
	}
}

func TestEditorsChangeTheExpiryAFewTimesUntilTheOwnerSetsIt(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	doc, _, err := store.CreateDocument(ctx, expiryOwner, "Scratch", "", []byte("<p>scratch</p>"), repo.WithExpiry(fromNow(1)))
	if err != nil {
		t.Fatal(err)
	}
	later := func(days int) error {
		at := fromNow(days)
		_, err := store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{ExpiresAt: &at, OnlyLater: true})
		return err
	}
	for i := range repo.MaxExpiryEditorChanges {
		if err := later(2 + i); err != nil {
			t.Fatalf("change %d of an editor: %v", i+1, err)
		}
	}
	if err := later(30); !errors.Is(err, repo.ErrExpiryChangesUsed) {
		t.Fatalf("one change too many: %v, want ErrExpiryChangesUsed", err)
	}
	if got, err := store.GetDocument(ctx, doc.ID); err != nil || got.ExpiryEditorChangesLeft == nil || *got.ExpiryEditorChangesLeft != 0 {
		t.Fatalf("the document tells %v changes left, %v, want 0", got.ExpiryEditorChangesLeft, err)
	}
	month := fromNow(30)
	if _, err := store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{ExpiresAt: &month}); err != nil {
		t.Fatal(err)
	}
	if err := later(60); err != nil {
		t.Fatalf("a change of an editor after one of the owner: %v", err)
	}
	if got, _ := store.GetDocument(ctx, doc.ID); got.ExpiryEditorChangesLeft == nil || *got.ExpiryEditorChangesLeft != repo.MaxExpiryEditorChanges-1 {
		t.Fatalf("the document tells %v changes left, want %d", got.ExpiryEditorChangesLeft, repo.MaxExpiryEditorChanges-1)
	}
}

func TestChangeDocumentOfNoDocumentIsNotFound(t *testing.T) {
	store := newStore(t)
	week := fromNow(7)
	title := "Gone"
	for name, change := range map[string]repo.DocumentChange{
		"expiry": {ExpiresAt: &week},
		"title":  {Title: &title},
	} {
		if _, err := store.ChangeDocument(context.Background(), "doc_missing", change); !errors.Is(err, repo.ErrNotFound) {
			t.Errorf("a change of the %s of no document gave %v, want ErrNotFound", name, err)
		}
	}
}

// number scans one count.
func number(t *testing.T, store *pgrepo.Store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := store.Pool().QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// scratch makes a document with two versions and a comment. With expired,
// its expiry time passed that many minutes ago.
func scratch(t *testing.T, store *pgrepo.Store, title string, expired int) repo.Document {
	t.Helper()
	ctx := context.Background()
	doc, ver, err := store.CreateDocument(ctx, expiryOwner, title, "", []byte("<p>scratch</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SaveVersion(ctx, doc.ID, ver.ID, nil, expiryOwner, repo.Upload([]byte("<p>scratch two</p>"), "second")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateComment(ctx, doc.ID, ver.ID, "a note", repo.Anchor{Quote: "scratch"}, 0, expiryOwner, nil); err != nil {
		t.Fatal(err)
	}
	if expired > 0 {
		expire(t, store, doc.ID, expired)
	}
	return doc
}

// expire sets the expiry time of a document to some minutes ago, as the
// clock of the database does in time.
func expire(t *testing.T, store *pgrepo.Store, docID string, minutes int) {
	t.Helper()
	if _, err := store.Pool().Exec(context.Background(), `UPDATE documents SET expires_at = now() - make_interval(mins => $2) WHERE id = $1`, docID, minutes); err != nil {
		t.Fatal(err)
	}
}

func exists(t *testing.T, store *pgrepo.Store, docID string) bool {
	t.Helper()
	_, err := store.GetDocument(context.Background(), docID)
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		t.Fatal(err)
	}
	return err == nil
}

func blobsOfDocument(t *testing.T, blobs blob.Store, docID string) []string {
	t.Helper()
	keys, err := blobs.List(context.Background(), "docs/"+docID+"/")
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func ids(docs []pgrepo.ExpiredDocument) []string {
	out := make([]string, len(docs))
	for i, d := range docs {
		out[i] = d.ID
	}
	return out
}

// faultyBlobs is a blob store whose Delete fails for the keys that fail
// picks, and that runs onDelete before each Delete.
type faultyBlobs struct {
	blob.Store
	fail     func(key string) bool
	onDelete func()
}

func (f *faultyBlobs) Delete(ctx context.Context, key string) error {
	if f.onDelete != nil {
		f.onDelete()
	}
	if f.fail != nil && f.fail(key) {
		return fmt.Errorf("%w: delete %q: the store is down", blob.ErrStorage, key)
	}
	return f.Store.Delete(ctx, key)
}

// A delete by hand left the HTML of the document in the blob store for ever.
// It now puts the document in the list of blob deletions, and the blobs stay
// until the purge.
func TestADeleteByHandQueuesTheBlobsOfTheDocument(t *testing.T) {
	ctx := context.Background()
	store, _, blobs := servers(t)
	doc := scratch(t, store, "By hand", 0)
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if exists(t, store, doc.ID) {
		t.Fatal("the document is still there")
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions WHERE document_id = $1`, doc.ID); n != 1 {
		t.Fatalf("the list of blob deletions holds the document %d times, want once", n)
	}
	if keys := blobsOfDocument(t, blobs, doc.ID); len(keys) != 2 {
		t.Fatalf("the blob store holds %q, want the two versions until the purge", keys)
	}
	// A second delete finds no document and queues nothing.
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDocument(ctx, "doc_missing"); err != nil {
		t.Fatal(err)
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions`); n != 1 {
		t.Fatalf("the list of blob deletions holds %d rows, want 1", n)
	}
}

func TestTheSweepDeletesOnlyTheDocumentsWhoseExpiryPassed(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	expired := scratch(t, store, "Expired", 5)
	kept := scratch(t, store, "Kept", 0)
	later := scratch(t, store, "Later", 0)
	week := fromNow(7)
	if _, err := store.ChangeDocument(ctx, later.ID, repo.DocumentChange{ExpiresAt: &week}); err != nil {
		t.Fatal(err)
	}

	deleted, err := store.DeleteExpiredDocuments(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(deleted); !slices.Equal(got, []string{expired.ID}) {
		t.Fatalf("the sweep deleted %q, want %q", got, expired.ID)
	}
	// The clock of the database set the time, so it also tells its age.
	var now time.Time
	if err := store.Pool().QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		t.Fatal(err)
	}
	if age := now.Sub(deleted[0].ExpiresAt); age < 4*time.Minute || age > 6*time.Minute {
		t.Fatalf("the sweep gave the expiry time %v, want 5 minutes before %v", deleted[0].ExpiresAt, now)
	}
	if exists(t, store, expired.ID) || !exists(t, store, kept.ID) || !exists(t, store, later.ID) {
		t.Fatal("the sweep did not delete the expired document and keep the two others")
	}
	for _, table := range []string{"versions", "comments", "document_ops"} {
		if n := number(t, store, `SELECT count(*) FROM `+table+` WHERE document_id = $1`, expired.ID); n != 0 {
			t.Errorf("%s holds %d rows of the expired document", table, n)
		}
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions WHERE document_id = $1`, expired.ID); n != 1 {
		t.Fatalf("the list of blob deletions holds the document %d times, want once", n)
	}
	// A second round finds nothing.
	if deleted, err = store.DeleteExpiredDocuments(ctx, 10); err != nil || len(deleted) != 0 {
		t.Fatalf("a second sweep deleted %q, %v", ids(deleted), err)
	}
}

// The owner can change the expiry until the delete.
func TestTheSweepKeepsADocumentWhoseExpiryTheOwnerRemoved(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc := scratch(t, store, "Second thoughts", 5)
	none := time.Time{}
	if _, err := store.ChangeDocument(ctx, doc.ID, repo.DocumentChange{ExpiresAt: &none}); err != nil {
		t.Fatal(err)
	}
	if deleted, err := store.DeleteExpiredDocuments(ctx, 10); err != nil || len(deleted) != 0 {
		t.Fatalf("the sweep deleted %q, %v", ids(deleted), err)
	}
	if !exists(t, store, doc.ID) {
		t.Fatal("the document is gone")
	}
}

func TestTheSweepStopsAtItsLimitWithTheOldestFirst(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	newest := scratch(t, store, "Newest", 1)
	oldest := scratch(t, store, "Oldest", 30)
	middle := scratch(t, store, "Middle", 10)
	deleted, err := store.DeleteExpiredDocuments(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(deleted); !slices.Equal(got, []string{oldest.ID, middle.ID}) {
		t.Fatalf("the sweep deleted %q, want the oldest and the middle", got)
	}
	if !exists(t, store, newest.ID) {
		t.Fatal("the sweep went past its limit")
	}
}

// A write to the live document, an approval, and a new comment each hold
// the row of the document. The sweep does not wait for them: it passes over
// the document, and a later round deletes it.
func TestTheSweepPassesOverADocumentThatAWriteHolds(t *testing.T) {
	for _, lock := range []string{"FOR NO KEY UPDATE", "FOR KEY SHARE"} {
		t.Run(lock, func(t *testing.T) {
			ctx := context.Background()
			store := newStore(t)
			held := scratch(t, store, "Held", 30)
			free := scratch(t, store, "Free", 5)
			tx, err := store.Pool().Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err := tx.Exec(ctx, `SELECT 1 FROM documents WHERE id = $1 `+lock, held.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			var deleted []pgrepo.ExpiredDocument
			go func() {
				defer close(done)
				deleted, err = store.DeleteExpiredDocuments(ctx, 10)
			}()
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Fatal("the sweep waited for the write")
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := ids(deleted); !slices.Equal(got, []string{free.ID}) {
				t.Fatalf("the sweep deleted %q, want only the free document", got)
			}
			if err := tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			if deleted, err = store.DeleteExpiredDocuments(ctx, 10); err != nil || !slices.Equal(ids(deleted), []string{held.ID}) {
				t.Fatalf("the next sweep deleted %q, %v, want the document that was held", ids(deleted), err)
			}
		})
	}
}

// One document whose delete fails does not keep the sweep from the others,
// in this round or the next.
func TestTheSweepGoesOnAfterADocumentThatFails(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	broken := scratch(t, store, "Broken", 30)
	fine := scratch(t, store, "Fine", 5)
	exec(t, store,
		`CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'this document cannot go'; END $$`,
		`CREATE TRIGGER refuse_delete BEFORE DELETE ON documents FOR EACH ROW WHEN (OLD.id = '`+broken.ID+`') EXECUTE FUNCTION refuse_delete()`)
	deleted, err := store.DeleteExpiredDocuments(ctx, 10)
	if got := ids(deleted); !slices.Equal(got, []string{fine.ID}) {
		t.Fatalf("the sweep deleted %q, want the document after the broken one", got)
	}
	if err == nil || !strings.Contains(err.Error(), broken.ID) {
		t.Fatalf("the sweep gave the error %v, want one that names %s", err, broken.ID)
	}
	if !exists(t, store, broken.ID) {
		t.Fatal("the broken document is gone")
	}
	// The failed delete left nothing behind.
	if n := number(t, store, `SELECT count(*) FROM blob_deletions WHERE document_id = $1`, broken.ID); n != 0 {
		t.Fatalf("the list of blob deletions holds the broken document %d times", n)
	}
}

// Every server runs the sweep. Two of them delete each document once.
func TestTwoServersDeleteEachExpiredDocumentOnce(t *testing.T) {
	ctx := context.Background()
	a, b, _ := servers(t)
	want := map[string]bool{}
	for i := range 12 {
		want[scratch(t, a, fmt.Sprintf("Shared %d", i), i+1).ID] = true
	}
	results := make(chan []pgrepo.ExpiredDocument, 2)
	failures := make(chan error, 2)
	for _, server := range []*pgrepo.Store{a, b} {
		go func() {
			var all []pgrepo.ExpiredDocument
			for {
				deleted, err := server.DeleteExpiredDocuments(ctx, 3)
				if err != nil {
					failures <- err
					return
				}
				// The other server can hold the last documents. A round
				// that finds none after that is the end.
				var left int
				if err := server.Pool().QueryRow(ctx, `SELECT count(*) FROM documents WHERE expires_at <= now()`).Scan(&left); err != nil {
					failures <- err
					return
				}
				if len(deleted) == 0 && left == 0 {
					results <- all
					return
				}
				all = append(all, deleted...)
			}
		}()
	}
	seen := map[string]int{}
	for range 2 {
		select {
		case deleted := <-results:
			for _, d := range deleted {
				seen[d.ID]++
			}
		case err := <-failures:
			t.Fatal(err)
		case <-time.After(60 * time.Second):
			t.Fatal("the two sweeps did not end")
		}
	}
	if len(seen) != len(want) {
		t.Fatalf("the servers deleted %d documents, want %d", len(seen), len(want))
	}
	for id, n := range seen {
		if !want[id] || n != 1 {
			t.Errorf("the document %s was deleted %d times", id, n)
		}
	}
	if n := number(t, a, `SELECT count(*) FROM blob_deletions`); n != len(want) {
		t.Fatalf("the list of blob deletions holds %d rows, want %d", n, len(want))
	}
}

func TestThePurgeRemovesTheBlobsOfADeletedDocument(t *testing.T) {
	ctx := context.Background()
	store, _, blobs := servers(t)
	gone := scratch(t, store, "Gone", 5)
	living := scratch(t, store, "Living", 0)
	// A blob that no version names, as a seal leaves when its delete failed.
	stray := "docs/" + gone.ID + "/ver_stray.seal_1.html"
	if err := blobs.Put(ctx, stray, "text/html", []byte("stray")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeleteExpiredDocuments(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if keys := blobsOfDocument(t, blobs, gone.ID); len(keys) != 3 {
		t.Fatalf("before the purge the blob store holds %q, want three blobs", keys)
	}

	purge, err := store.PurgeDeletedBlobs(ctx, 0, 10)
	if err != nil || purge.Purged != 1 || purge.Failed != 0 || purge.Err != nil {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want one document", purge, err)
	}
	if keys := blobsOfDocument(t, blobs, gone.ID); len(keys) != 0 {
		t.Fatalf("after the purge the blob store holds %q", keys)
	}
	if keys := blobsOfDocument(t, blobs, living.ID); len(keys) != 2 {
		t.Fatalf("the living document has the blobs %q, want its two versions", keys)
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions`); n != 0 {
		t.Fatalf("the list of blob deletions holds %d rows after the purge", n)
	}
	if html, err := store.GetVersionHTML(ctx, living.CurrentVersionID); err != nil || len(html) == 0 {
		t.Fatalf("the living document has the content %q, %v", html, err)
	}
}

// The list of blob deletions is empty most of the time, and the database
// plans the queries on it for an empty table. With that plan a claim that
// joined the list to "the next document" ran the choice of the next document
// again for each row, and took every waiting document. The purge had the
// first one only: the others kept the lease of a claim that nobody had, and
// their blobs stayed until it ended.
func TestAClaimTakesOneDocumentWhenTheListIsPlannedAsEmpty(t *testing.T) {
	ctx := context.Background()
	store, _, blobs := servers(t)
	// A document that came and went leaves the table with a page and no row.
	// That is what the statistics of the table then tell.
	first := scratch(t, store, "First", 0)
	if err := store.DeleteDocument(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if purge, err := store.PurgeDeletedBlobs(ctx, 0, 10); err != nil || purge.Purged != 1 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want one document", purge, err)
	}
	if _, err := store.Pool().Exec(ctx, `ANALYZE blob_deletions`); err != nil {
		t.Fatal(err)
	}

	var docs []repo.Document
	for _, title := range []string{"One", "Two", "Three"} {
		doc := scratch(t, store, title, 0)
		if err := store.DeleteDocument(ctx, doc.ID); err != nil {
			t.Fatal(err)
		}
		docs = append(docs, doc)
	}

	// One document of the three, so that the purge makes one claim.
	purge, err := store.PurgeDeletedBlobs(ctx, 0, 1)
	if err != nil || purge.Purged != 1 || purge.Failed != 0 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want one document", purge, err)
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions WHERE attempts > 0`); n != 0 {
		t.Fatalf("the claim of one document left %d more documents with a lease", n)
	}

	purge, err = store.PurgeDeletedBlobs(ctx, 0, 10)
	if err != nil || purge.Purged != 2 || purge.Failed != 0 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want the two documents that waited", purge, err)
	}
	for _, doc := range docs {
		if keys := blobsOfDocument(t, blobs, doc.ID); len(keys) != 0 {
			t.Errorf("the blob store holds %q of a deleted document after the purge", keys)
		}
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions`); n != 0 {
		t.Fatalf("the list of blob deletions holds %d rows after the purge", n)
	}
}

// The blobs stay for the retention period, so that an operator can get the
// HTML back, and a restore of a backup of the database finds its blobs.
func TestThePurgeWaitsForTheRetentionPeriod(t *testing.T) {
	ctx := context.Background()
	store, _, blobs := servers(t)
	doc := scratch(t, store, "Retained", 0)
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if purge, err := store.PurgeDeletedBlobs(ctx, time.Hour, 10); err != nil || purge.Purged != 0 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want nothing in the retention period", purge, err)
	}
	if keys := blobsOfDocument(t, blobs, doc.ID); len(keys) != 2 {
		t.Fatalf("the blob store holds %q in the retention period, want the two versions", keys)
	}
	if n := number(t, store, `SELECT attempts FROM blob_deletions WHERE document_id = $1`, doc.ID); n != 0 {
		t.Fatalf("the purge took the row %d times in the retention period", n)
	}
	exec(t, store, `UPDATE blob_deletions SET queued_at = now() - interval '2 hours'`)
	if purge, err := store.PurgeDeletedBlobs(ctx, time.Hour, 10); err != nil || purge.Purged != 1 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want the document after the retention period", purge, err)
	}
	if keys := blobsOfDocument(t, blobs, doc.ID); len(keys) != 0 {
		t.Fatalf("the blob store holds %q after the retention period", keys)
	}
}

// A blob store that is down loses nothing: the document stays in the list,
// and waits longer after each attempt.
func TestThePurgeKeepsADocumentWhoseBlobsTheStoreDidNotDelete(t *testing.T) {
	ctx := context.Background()
	plain, _, memory := servers(t)
	down := true
	faulty := &faultyBlobs{Store: memory, fail: func(string) bool { return down }}
	store := pgrepo.NewWithBlob(plain.Pool(), faulty)
	doc := scratch(t, store, "Store down", 0)
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}

	purge, err := store.PurgeDeletedBlobs(ctx, 0, 10)
	if err != nil || purge.Purged != 0 || purge.Failed != 1 || !errors.Is(purge.Err, blob.ErrStorage) {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want one failed document and the error of the store", purge, err)
	}
	if keys := blobsOfDocument(t, memory, doc.ID); len(keys) != 2 {
		t.Fatalf("the blob store holds %q", keys)
	}
	if n := number(t, store, `SELECT attempts FROM blob_deletions WHERE document_id = $1 AND available_at > now()`, doc.ID); n != 1 {
		t.Fatalf("the row has %d attempts, want 1 and a later time", n)
	}
	// The row waits, so the next round does not take it.
	down = false
	if purge, err = store.PurgeDeletedBlobs(ctx, 0, 10); err != nil || purge.Purged != 0 || purge.Failed != 0 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want nothing while the row waits", purge, err)
	}
	exec(t, store, `UPDATE blob_deletions SET available_at = now()`)
	if purge, err = store.PurgeDeletedBlobs(ctx, 0, 10); err != nil || purge.Purged != 1 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want the document when the store is up", purge, err)
	}
	if keys := blobsOfDocument(t, memory, doc.ID); len(keys) != 0 {
		t.Fatalf("the blob store holds %q", keys)
	}
}

func TestADocumentThatFailsDoesNotStopThePurgeOfTheOthers(t *testing.T) {
	ctx := context.Background()
	plain, _, memory := servers(t)
	first := scratch(t, plain, "First", 0)
	second := scratch(t, plain, "Second", 0)
	faulty := &faultyBlobs{Store: memory, fail: func(key string) bool { return strings.HasPrefix(key, "docs/"+first.ID+"/") }}
	store := pgrepo.NewWithBlob(plain.Pool(), faulty)
	for _, id := range []string{first.ID, second.ID} {
		if err := store.DeleteDocument(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	exec(t, store, `UPDATE blob_deletions SET queued_at = now() - interval '1 hour' WHERE document_id = '`+first.ID+`'`)
	purge, err := store.PurgeDeletedBlobs(ctx, 0, 10)
	if err != nil || purge.Purged != 1 || purge.Failed != 1 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want one document and one failed", purge, err)
	}
	if keys := blobsOfDocument(t, memory, second.ID); len(keys) != 0 {
		t.Fatalf("the blob store holds %q of the second document", keys)
	}
}

// The blob store can be slow. The purge holds no connection of the pool
// while it waits for it.
func TestThePurgeHoldsNoConnectionWhileItDeletes(t *testing.T) {
	ctx := context.Background()
	plain, _, memory := servers(t)
	held := []int32{}
	faulty := &faultyBlobs{Store: memory, onDelete: func() { held = append(held, plain.Pool().Stat().AcquiredConns()) }}
	store := pgrepo.NewWithBlob(plain.Pool(), faulty)
	doc := scratch(t, store, "Slow store", 0)
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if purge, err := store.PurgeDeletedBlobs(ctx, 0, 10); err != nil || purge.Purged != 1 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v", purge, err)
	}
	if !slices.Equal(held, []int32{0, 0}) {
		t.Fatalf("the purge held %v connections at its two deletes, want none", held)
	}
}

// A row for a living document cannot be: a delete makes the row, and an ID
// is never used again. If one is there, the purge must not take the blobs
// of the document.
func TestThePurgeKeepsTheBlobsOfALivingDocument(t *testing.T) {
	ctx := context.Background()
	store, _, blobs := servers(t)
	doc := scratch(t, store, "Alive", 0)
	exec(t, store, `INSERT INTO blob_deletions(document_id) VALUES ('`+doc.ID+`')`)
	purge, err := store.PurgeDeletedBlobs(ctx, 0, 10)
	if err != nil || purge.Purged != 0 || purge.Failed != 0 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want nothing", purge, err)
	}
	if keys := blobsOfDocument(t, blobs, doc.ID); len(keys) != 2 {
		t.Fatalf("the living document has the blobs %q, want its two versions", keys)
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions`); n != 0 {
		t.Fatalf("the row of the living document is still in the list")
	}
}

func TestTheBacklogTellsHowManyDocumentsWaitAndForHowLong(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	if backlog, err := store.BlobDeletionBacklog(ctx); err != nil || backlog.Documents != 0 || backlog.Oldest != 0 {
		t.Fatalf("BlobDeletionBacklog = %+v, %v, want nothing", backlog, err)
	}
	for _, title := range []string{"One", "Two"} {
		if err := store.DeleteDocument(ctx, scratch(t, store, title, 0).ID); err != nil {
			t.Fatal(err)
		}
	}
	exec(t, store, `UPDATE blob_deletions SET queued_at = now() - interval '3 hours' WHERE document_id = (SELECT min(document_id) FROM blob_deletions)`)
	backlog, err := store.BlobDeletionBacklog(ctx)
	if err != nil || backlog.Documents != 2 || backlog.Oldest < 3*time.Hour || backlog.Oldest > 3*time.Hour+time.Minute {
		t.Fatalf("BlobDeletionBacklog = %+v, %v, want 2 documents and 3 hours", backlog, err)
	}
}

// The log of the sweep tells whose document it deleted. The row of the
// document is gone by then, so the sweep returns the owner.
func TestTheSweepTellsWhoOwnedTheDocument(t *testing.T) {
	store := newStore(t)
	doc := scratch(t, store, "Owned", 5)
	deleted, err := store.DeleteExpiredDocuments(context.Background(), 10)
	if err != nil || len(deleted) != 1 {
		t.Fatalf("the sweep deleted %q, %v", ids(deleted), err)
	}
	if got := deleted[0]; got.ID != doc.ID || got.OwnerType != string(expiryOwner.Type) || got.OwnerID != expiryOwner.ID {
		t.Fatalf("the sweep returned %+v, want the document of %s", got, expiryOwner.ID)
	}
}

// The owner removes the expiry while the sweep runs. Before the commit the
// sweep passes over the document and does not wait. After it, the document
// is not expired.
func TestAnOwnerWhoRemovesTheExpiryDuringTheSweepKeepsTheDocument(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc := scratch(t, store, "Just in time", 5)
	tx, err := store.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE documents SET expires_at = NULL WHERE id = $1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	sweep := func(when string) {
		t.Helper()
		done := make(chan struct{})
		var deleted []pgrepo.ExpiredDocument
		var err error
		go func() {
			defer close(done)
			deleted, err = store.DeleteExpiredDocuments(ctx, 10)
		}()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s the commit, the sweep waited for the owner", when)
		}
		if err != nil || len(deleted) != 0 {
			t.Fatalf("%s the commit, the sweep deleted %q, %v", when, ids(deleted), err)
		}
	}
	sweep("before")
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	sweep("after")
	if !exists(t, store, doc.ID) {
		t.Fatal("the document is gone")
	}
}

// A write that comes after the delete finds no document, and removes the
// blob that it made. So the purge, which lists the blobs a moment later,
// finds all of them.
func TestAWriteAfterTheDeleteLeavesNoBlob(t *testing.T) {
	ctx := context.Background()
	store, _, blobs := servers(t)
	doc, ver, err := store.CreateDocument(ctx, expiryOwner, "Late write", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SaveVersion(ctx, doc.ID, ver.ID, nil, expiryOwner, repo.Upload([]byte("<p>two</p>"), "late")); err == nil {
		t.Fatal("a push to a deleted document made a version")
	}
	if _, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_late", 3, "x"), expiryOwner); err == nil {
		t.Fatal("an operation on a deleted document was stored")
	}
	if keys := blobsOfDocument(t, blobs, doc.ID); len(keys) != 1 {
		t.Fatalf("after the late writes the blob store holds %q, want only the first version", keys)
	}
	if purge, err := store.PurgeDeletedBlobs(ctx, 0, 10); err != nil || purge.Purged != 1 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v", purge, err)
	}
	if keys := blobsOfDocument(t, blobs, doc.ID); len(keys) != 0 {
		t.Fatalf("after the purge the blob store holds %q", keys)
	}
}

// A blob store that is down answers each call after its timeout. The purge
// stops after three documents in a row, and leaves the others for a later
// round.
func TestThePurgeStopsWhenTheStoreFailsThreeTimesInARow(t *testing.T) {
	ctx := context.Background()
	plain, _, memory := servers(t)
	store := pgrepo.NewWithBlob(plain.Pool(), &faultyBlobs{Store: memory, fail: func(string) bool { return true }})
	for i := range 5 {
		if err := store.DeleteDocument(ctx, scratch(t, store, fmt.Sprintf("Down %d", i), 0).ID); err != nil {
			t.Fatal(err)
		}
	}
	purge, err := store.PurgeDeletedBlobs(ctx, 0, 10)
	if err != nil || purge.Purged != 0 || purge.Failed != 3 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want three failed documents", purge, err)
	}
	if n := number(t, store, `SELECT count(*) FROM blob_deletions WHERE attempts = 0`); n != 2 {
		t.Fatalf("%d documents were not tried, want 2", n)
	}
}

// A server that takes longer than its lease loses the document to another
// server. It must not remove the row of that server: its blobs are gone, but
// the other server finishes the row.
func TestAServerThatLostItsLeaseLeavesTheRowToTheNextServer(t *testing.T) {
	ctx := context.Background()
	plain, _, memory := servers(t)
	taken := false
	faulty := &faultyBlobs{Store: memory}
	faulty.onDelete = func() {
		if !taken {
			taken = true
			exec(t, plain, `UPDATE blob_deletions SET attempts = attempts + 1`)
		}
	}
	store := pgrepo.NewWithBlob(plain.Pool(), faulty)
	doc := scratch(t, store, "Slow", 0)
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PurgeDeletedBlobs(ctx, 0, 10); err != nil {
		t.Fatal(err)
	}
	if n := number(t, store, `SELECT attempts FROM blob_deletions WHERE document_id = $1`, doc.ID); n != 2 {
		t.Fatalf("the row of the other server has %d attempts, want it there with 2", n)
	}
	if keys := blobsOfDocument(t, memory, doc.ID); len(keys) != 0 {
		t.Fatalf("the blob store holds %q", keys)
	}
}

// A server that stops in the middle of a purge is no failure of the blob
// store. The document keeps its lease, and a later round takes it.
func TestThePurgeDoesNotCountAServerThatStopsAsAFailure(t *testing.T) {
	plain, _, memory := servers(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	faulty := &faultyBlobs{Store: memory, onDelete: cancel, fail: func(string) bool { return true }}
	store := pgrepo.NewWithBlob(plain.Pool(), faulty)
	doc := scratch(t, store, "Shutdown", 0)
	if err := store.DeleteDocument(context.Background(), doc.ID); err != nil {
		t.Fatal(err)
	}
	purge, err := store.PurgeDeletedBlobs(ctx, 0, 10)
	if !errors.Is(err, context.Canceled) || purge.Failed != 0 || purge.Purged != 0 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v, want the end of the context and no failure", purge, err)
	}
	if n := number(t, plain, `SELECT count(*) FROM blob_deletions WHERE document_id = $1`, doc.ID); n != 1 {
		t.Fatalf("the document is in the list %d times, want once", n)
	}
}

// strangeLister is a blob store whose List returns a key that is not under
// the prefix, as a store with a bug can.
type strangeLister struct {
	blob.Store
	deleted []string
}

func (s *strangeLister) List(ctx context.Context, prefix string) ([]string, error) {
	keys, err := s.Store.List(ctx, prefix)
	return append(keys, "docs/other/ver_1.html"), err
}

func (s *strangeLister) Delete(ctx context.Context, key string) error {
	s.deleted = append(s.deleted, key)
	return s.Store.Delete(ctx, key)
}

// The purge deletes only keys of the document, whatever the store lists.
func TestThePurgeDeletesOnlyKeysOfTheDocument(t *testing.T) {
	ctx := context.Background()
	plain, _, memory := servers(t)
	strange := &strangeLister{Store: memory}
	store := pgrepo.NewWithBlob(plain.Pool(), strange)
	doc := scratch(t, store, "Strict", 0)
	if err := store.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if purge, err := store.PurgeDeletedBlobs(ctx, 0, 10); err != nil || purge.Purged != 1 {
		t.Fatalf("PurgeDeletedBlobs = %+v, %v", purge, err)
	}
	if len(strange.deleted) != 2 {
		t.Fatalf("the purge deleted %q, want the two versions of the document", strange.deleted)
	}
	for _, key := range strange.deleted {
		if !strings.HasPrefix(key, "docs/"+doc.ID+"/") {
			t.Errorf("the purge deleted %q, which is not a key of the document", key)
		}
	}
}
