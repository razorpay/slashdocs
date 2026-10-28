package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestPostgresDocumentPreview(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_preview_owner", Email: "preview-owner@test.com"}
	html := "<html><head><title>Plan</title><style>p{}</style></head><body><h1>Plan</h1><p>Ship it.</p>" +
		strings.Repeat("<p>word</p>", 1000) + "</body></html>"
	doc, _, err := store.CreateDocument(ctx, owner, "Plan", []byte(html))
	if err != nil {
		t.Fatal(err)
	}

	got, err := store.DocumentPreview(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.Text, "Plan Plan Ship it. word") {
		t.Errorf("text starts %q", got.Text[:min(len(got.Text), 60)])
	}
	if n := utf8.RuneCountInString(got.Text); n != 2000 {
		t.Errorf("text has %d characters, want 2000", n)
	}
	if got.UpdatedAt.IsZero() {
		t.Error("UpdatedAt is zero")
	}

	if _, err := store.DocumentPreview(ctx, "doc_missing"); !errors.Is(err, repo.ErrNotFound) {
		t.Errorf("missing document: err = %v, want ErrNotFound", err)
	}
}
