package server

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestMoveSourceTokenIsOpaqueAndBound(t *testing.T) {
	h := handlers{deps: dependencies{sessionSecret: "test-secret"}}
	principal := auth.Principal{Type: auth.PrincipalUser, ID: "usr_1"}
	source := repo.MoveSource{Kind: "folder", FolderID: "fld_secret"}
	token := h.signMoveSourceToken(principal, "doc_1", source)
	if !strings.HasPrefix(token, "ms1.") || strings.Count(token, ".") != 1 {
		t.Fatalf("token=%q", token)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, "ms1."))
	if err != nil || len(decoded) != 64 {
		t.Fatalf("decoded token len=%d err=%v", len(decoded), err)
	}
	if strings.Contains(token, source.FolderID) || strings.Contains(token, "doc_1") {
		t.Fatalf("token contains source data: %q", token)
	}
	if !h.verifyMoveSourceToken(token, principal, "doc_1", source) {
		t.Fatal("valid token rejected")
	}
	for _, malformed := range []string{"", "ms1.short", "v1." + strings.Repeat("A", 86), token + "A"} {
		if h.verifyMoveSourceToken(malformed, principal, "doc_1", source) {
			t.Fatalf("malformed token accepted: %q", malformed)
		}
	}
	for _, changed := range []struct {
		principal auth.Principal
		doc       string
		source    repo.MoveSource
	}{
		{principal: auth.Principal{Type: auth.PrincipalUser, ID: "usr_2"}, doc: "doc_1", source: source},
		{principal: principal, doc: "doc_2", source: source},
		{principal: principal, doc: "doc_1", source: repo.MoveSource{Kind: "root"}},
		{principal: principal, doc: "doc_1", source: repo.MoveSource{Kind: "folder", FolderID: "fld_other"}},
	} {
		if h.verifyMoveSourceToken(token, changed.principal, changed.doc, changed.source) {
			t.Fatalf("token accepted for changed binding: %+v", changed)
		}
	}
}

func TestMoveDestinationSourceOmitsTokenForNonMover(t *testing.T) {
	h := handlers{deps: dependencies{sessionSecret: "test-secret"}}
	principal := auth.Principal{Type: auth.PrincipalUser, ID: "usr_1"}
	response := h.moveDestinationSource(principal, repo.MoveDestinationResource{
		Type: "document", ID: "doc_1", CanMove: false, Source: repo.MoveSource{Kind: "root"}, SourceVisible: true,
	})
	if response.Token != "" {
		t.Fatalf("non-mover received source token: %+v", response)
	}
}

func TestMoveDestinationCursorIsResourceAndPrincipalScoped(t *testing.T) {
	h := handlers{deps: dependencies{sessionSecret: "test-secret"}}
	principal := auth.Principal{Type: auth.PrincipalUser, ID: "usr_1"}
	token := h.signMoveDestinationCursor(principal, "document", "doc_1", "fld_parent", "after", repo.MoveDestinationKey{Title: "alpha", ID: "fld_a"})
	key, ok := h.verifyMoveDestinationCursor(token, principal, "document", "doc_1", "fld_parent")
	if !ok || key.Title != "alpha" || key.ID != "fld_a" || key.Before {
		t.Fatalf("valid cursor=%+v ok=%t", key, ok)
	}
	for _, test := range []struct {
		principal auth.Principal
		typeName  string
		resource  string
		parent    string
	}{
		{principal: auth.Principal{Type: auth.PrincipalUser, ID: "usr_2"}, typeName: "document", resource: "doc_1", parent: "fld_parent"},
		{principal: principal, typeName: "folder", resource: "doc_1", parent: "fld_parent"},
		{principal: principal, typeName: "document", resource: "doc_2", parent: "fld_parent"},
		{principal: principal, typeName: "document", resource: "doc_1", parent: "fld_other"},
	} {
		if _, ok := h.verifyMoveDestinationCursor(token, test.principal, test.typeName, test.resource, test.parent); ok {
			t.Fatalf("cursor accepted outside scope: %+v", test)
		}
	}
}
