package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestPostgresRepositoryDocumentGrantVersionCommentFlow(t *testing.T) {
	store := newStore(t)

	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_pg_owner", Email: "pg-owner@example.com", Name: "Owner"}
	doc, ver, err := store.CreateDocument(context.Background(), owner, "Postgres doc", []byte("<html>v1</html>"))
	if err != nil {
		t.Fatal(err)
	}
	if doc.CurrentVersionID != ver.ID {
		t.Fatalf("current version mismatch")
	}

	role, err := store.RoleForDocument(context.Background(), owner, doc.ID)
	if err != nil || role != repo.RoleOwner {
		t.Fatalf("role=%s err=%v", role, err)
	}

	sa, err := store.CreateServiceAccount(context.Background(), owner, "pg-bot")
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateGrant(context.Background(), "document", doc.ID, auth.Principal{Type: auth.PrincipalServiceAccount, ID: sa.ID}, repo.RoleEditor, owner)
	if err != nil {
		t.Fatal(err)
	}
	role, err = store.RoleForDocument(context.Background(), auth.Principal{Type: auth.PrincipalServiceAccount, ID: sa.ID}, doc.ID)
	if err != nil || role != repo.RoleEditor {
		t.Fatalf("sa role=%s err=%v", role, err)
	}

	_, err = store.CreateVersion(context.Background(), doc.ID, "stale", "bad", []byte("<html>bad</html>"), owner, false)
	if err == nil || err.Error() != "version_conflict" {
		t.Fatalf("want version_conflict, got %v", err)
	}

	ver2, err := store.CreateVersion(context.Background(), doc.ID, ver.ID, "updated", []byte("<html>v2</html>"), owner, false)
	if err != nil {
		t.Fatal(err)
	}
	if ver2.Number != 2 {
		t.Fatalf("number=%d", ver2.Number)
	}

	commenter := auth.Principal{Type: auth.PrincipalUser, ID: "usr_pg_commenter", Email: "c@example.com", Name: "Commenter"}
	cm, err := store.CreateComment(context.Background(), doc.ID, ver2.ID, "Looks good", repo.Anchor{Quote: "v2", Prefix: "<html>", Suffix: "</html>", DOMPath: "body", StartOffset: 0, EndOffset: 2}, commenter, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cm.SelectedText != "v2" || cm.Status != "open" {
		t.Fatalf("bad comment: %+v", cm)
	}
}

// A public ("anyone") grant gives a stranger access to the document via the
// link, but it only joins their workspace listing once they open it -- and an
// explicit grant lists the document without needing an open.
func TestPostgresAnyoneGrantListsAfterOpen(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()

	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_pg_anyone_owner", Email: "anyone-owner@example.com", Name: "Owner"}
	doc, _, err := store.CreateDocument(ctx, owner, "Public sample", []byte("<html>public</html>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateGrant(ctx, "document", doc.ID, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleViewer, owner); err != nil {
		t.Fatal(err)
	}

	stranger := auth.Principal{Type: auth.PrincipalUser, ID: "usr_pg_anyone_stranger", Email: "stranger@example.com", Name: "Stranger"}

	// The stranger can reach the document via the public link.
	role, err := store.RoleForDocument(ctx, stranger, doc.ID)
	if err != nil || role != repo.RoleViewer {
		t.Fatalf("stranger role=%s err=%v, want viewer", role, err)
	}

	// Before opening, the public document is not in the stranger's workspace.
	if listed(t, store, stranger, doc.ID) {
		t.Fatalf("public doc %s listed before stranger opened it", doc.ID)
	}

	// Opening it adds it to their workspace.
	if err := store.RecordDocumentOpened(ctx, doc.ID, stranger); err != nil {
		t.Fatal(err)
	}
	if !listed(t, store, stranger, doc.ID) {
		t.Fatalf("public doc %s not listed after stranger opened it", doc.ID)
	}

	// A second user with an explicit grant sees it without opening.
	invitee := auth.Principal{Type: auth.PrincipalUser, ID: "usr_pg_anyone_invitee", Email: "invitee@example.com", Name: "Invitee"}
	if _, err := store.CreateGrant(ctx, "document", doc.ID, invitee, repo.RoleViewer, owner); err != nil {
		t.Fatal(err)
	}
	if !listed(t, store, invitee, doc.ID) {
		t.Fatalf("explicitly-granted doc %s not listed for invitee", doc.ID)
	}
}

func listed(t *testing.T, store *pgrepo.Store, p auth.Principal, docID string) bool {
	t.Helper()
	docs, err := store.ListDocuments(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if d.ID == docID {
			return true
		}
	}
	return false
}

func TestPostgresCreateDocumentDeletesBlobWhenDBFailsAfterPut(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	blobs := &cancelAfterPutBlob{cancel: cancel}
	store, err := pgrepo.ConnectWithBlob(context.Background(), testdb.New(t), blobs)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_blob_cleanup_doc", Email: "blob-cleanup-doc@example.com", Name: "Owner"}
	_, _, err = store.CreateDocument(ctx, owner, "cleanup doc", []byte("<html>cleanup</html>"))
	if err == nil {
		t.Fatal("CreateDocument succeeded; want context cancellation after blob put")
	}
	if blobs.puts != 1 || blobs.deletes != 1 {
		t.Fatalf("blob puts=%d deletes=%d, want 1/1", blobs.puts, blobs.deletes)
	}
	if blobs.deletedKey != blobs.putKey {
		t.Fatalf("deleted key %q, want put key %q", blobs.deletedKey, blobs.putKey)
	}
}

func TestPostgresCreateVersionDeletesBlobWhenDBFailsAfterPut(t *testing.T) {
	blobs := &cancelAfterPutBlob{}
	store, err := pgrepo.ConnectWithBlob(context.Background(), testdb.New(t), blobs)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_blob_cleanup_ver", Email: "blob-cleanup-ver@example.com", Name: "Owner"}
	doc, ver, err := store.CreateDocument(context.Background(), owner, "cleanup version", []byte("<html>v1</html>"))
	if err != nil {
		t.Fatal(err)
	}
	blobs.puts, blobs.deletes, blobs.putKey, blobs.deletedKey = 0, 0, "", ""
	ctx, cancel := context.WithCancel(context.Background())
	blobs.cancel = cancel
	_, err = store.CreateVersion(ctx, doc.ID, ver.ID, "will fail", []byte("<html>v2</html>"), owner, false)
	if err == nil {
		t.Fatal("CreateVersion succeeded; want context cancellation after blob put")
	}
	if blobs.puts != 1 || blobs.deletes != 1 {
		t.Fatalf("blob puts=%d deletes=%d, want 1/1", blobs.puts, blobs.deletes)
	}
	if blobs.deletedKey != blobs.putKey {
		t.Fatalf("deleted key %q, want put key %q", blobs.deletedKey, blobs.putKey)
	}
}

type cancelAfterPutBlob struct {
	cancel     context.CancelFunc
	puts       int
	deletes    int
	putKey     string
	deletedKey string
}

func (b *cancelAfterPutBlob) Put(ctx context.Context, key, contentType string, body []byte) error {
	b.puts++
	b.putKey = key
	if b.cancel != nil {
		b.cancel()
	}
	return nil
}
func (b *cancelAfterPutBlob) Get(ctx context.Context, key string) ([]byte, string, error) {
	return nil, "", blob.ErrNotFound
}
func (b *cancelAfterPutBlob) Delete(ctx context.Context, key string) error {
	b.deletes++
	b.deletedKey = key
	return nil
}

func TestPostgresSearchDocumentsViaFolderGrant(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()

	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_pg_search_folder_owner", Email: "search-folder-owner@test.com", Name: "Owner"}
	viewer := auth.Principal{Type: auth.PrincipalUser, ID: "usr_pg_search_folder_viewer", Email: "search-folder-viewer@test.com", Name: "Viewer"}

	folder, err := store.CreateFolder(ctx, owner, "Payments Platform", "")
	if err != nil {
		t.Fatal(err)
	}
	child, err := store.CreateFolder(ctx, owner, "Runbooks", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := store.CreateDocument(ctx, owner, "SearchableInFolder", []byte("<html>hello</html>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveDocumentToFolder(ctx, owner, child.ID, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplaceDocumentLabels(ctx, doc.ID, []string{"api-review", "payments"}, owner); err != nil {
		t.Fatal(err)
	}

	// Before granting folder access, viewer cannot find the doc
	results, err := store.SearchDocuments(ctx, viewer, repo.DocumentSearch{Terms: []string{"searchableinfolder"}}, false, 25)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if r.ID == doc.ID {
			t.Fatal("viewer found doc before folder grant")
		}
	}

	// Grant viewer access on the folder
	if _, err := store.CreateGrant(ctx, "folder", folder.ID, viewer, repo.RoleViewer, owner); err != nil {
		t.Fatal(err)
	}

	// Now the viewer can find the doc via folder inheritance
	results, err = store.SearchDocuments(ctx, viewer, repo.DocumentSearch{
		Terms:         []string{"searchablein"},
		ExcludedTerms: []string{"draft"},
		Owners:        []string{"missing@test.com", "search-folder-owner"},
		Folders:       []string{"checkout", "payments platform"},
		Labels:        []string{"api-review", "payments"},
		UpdatedSince:  time.Now().Add(-time.Hour),
		UpdatedBefore: time.Now().Add(time.Hour),
		IncludeLabels: true,
	}, false, 25)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range results {
		if r.ID == doc.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("viewer cannot find doc after folder grant — folder-inherited search is broken")
	}
	if len(results) != 1 || len(results[0].Labels) != 2 {
		t.Fatalf("combined search results = %+v, want one result with labels", results)
	}

	results, err = store.SearchDocuments(ctx, viewer, repo.DocumentSearch{Labels: []string{"payments", "missing"}}, false, 25)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if r.ID == doc.ID {
			t.Fatal("AND label search matched a document missing the requested label")
		}
	}
}

// newStore connects a Store to a fresh test database.
func newStore(t *testing.T) *pgrepo.Store {
	t.Helper()
	store, err := pgrepo.Connect(context.Background(), testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store
}
