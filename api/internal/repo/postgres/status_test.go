package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestDocumentStatusSetAndRead(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "status_owner", Email: "status@example.com"}
	doc, _, err := store.CreateDocument(ctx, owner, "Reviewed", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := store.CreateDocument(ctx, owner, "Untouched", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}

	statuses, err := store.DocumentStatuses(ctx, []string{doc.ID, other.ID})
	if err != nil || statuses[doc.ID] != "" || statuses[other.ID] != "" {
		t.Fatalf("new document statuses = %v, %v; want empty", statuses, err)
	}

	if err := store.SetDocumentStatus(ctx, doc.ID, "in_review"); err != nil {
		t.Fatal(err)
	}
	statuses, err = store.DocumentStatuses(ctx, []string{doc.ID, other.ID})
	if err != nil || statuses[doc.ID] != "in_review" || statuses[other.ID] != "" {
		t.Fatalf("statuses after set = %v, %v", statuses, err)
	}

	if err := store.SetDocumentStatus(ctx, doc.ID, ""); err != nil {
		t.Fatal(err)
	}
	statuses, err = store.DocumentStatuses(ctx, []string{doc.ID})
	if err != nil || statuses[doc.ID] != "" {
		t.Fatalf("statuses after clear = %v, %v", statuses, err)
	}

	if err := store.SetDocumentStatus(ctx, doc.ID, "shipped"); err == nil {
		t.Fatal("set unknown status succeeded; want the check constraint to reject it")
	}
	if err := store.SetDocumentStatus(ctx, "doc_missing", "draft"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("set status on missing document = %v, want ErrNotFound", err)
	}
}
