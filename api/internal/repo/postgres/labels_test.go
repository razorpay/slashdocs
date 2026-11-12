package postgres_test

import (
	"context"
	"slices"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestDocumentLabelsReplaceAndFilter(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "label_owner", Email: "labels@example.com"}
	doc, _, err := store.CreateDocument(ctx, owner, "Labelled", "", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	labels, err := store.ReplaceDocumentLabels(ctx, doc.ID, []string{"payments", "runbook"}, owner)
	if err != nil || len(labels) != 2 {
		t.Fatalf("replace labels = %v, %v", labels, err)
	}
	docs, err := store.ListDocumentsByLabel(ctx, owner, "payments")
	if err != nil || len(docs) != 1 || docs[0].ID != doc.ID || !slices.Equal(docs[0].Labels, labels) {
		t.Fatalf("documents by label = %+v, %v", docs, err)
	}

	unlabelled, _, err := store.CreateDocument(ctx, owner, "Unlabelled", "", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	docs, _, err = store.ListDocuments(ctx, owner, repo.Page{Limit: 25}, true)
	if err != nil || len(docs) != 2 {
		t.Fatalf("list = %+v, %v", docs, err)
	}
	for _, d := range docs {
		if want := map[string][]string{doc.ID: labels, unlabelled.ID: nil}[d.ID]; !slices.Equal(d.Labels, want) {
			t.Errorf("labels of %s = %v, want %v", d.Title, d.Labels, want)
		}
	}
}
