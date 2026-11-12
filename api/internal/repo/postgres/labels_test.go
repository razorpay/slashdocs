package postgres_test

import (
	"context"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func TestDocumentLabelsReplaceAndFilter(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "label_owner", Email: "labels@example.com"}
	doc, _, err := store.CreateDocument(ctx, owner, "Labelled", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	labels, err := store.ReplaceDocumentLabels(ctx, doc.ID, []string{"payments", "runbook"}, owner)
	if err != nil || len(labels) != 2 {
		t.Fatalf("replace labels = %v, %v", labels, err)
	}
	docs, err := store.ListDocumentsByLabel(ctx, owner, "payments")
	if err != nil || len(docs) != 1 || docs[0].ID != doc.ID {
		t.Fatalf("documents by label = %+v, %v", docs, err)
	}
}
