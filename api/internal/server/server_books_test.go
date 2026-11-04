package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/server"
)

func bkHeaders(principal string) map[string]string {
	return map[string]string{"X-Test-Principal": principal, "Content-Type": "application/json"}
}

// jsonPath reads a dotted path of object keys and array indexes from a body.
func bkPath(t *testing.T, body []byte, path string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("response is not JSON: %v; body=%s", err, body)
	}
	for _, part := range strings.Split(path, ".") {
		switch node := v.(type) {
		case map[string]any:
			v = node[part]
		case []any:
			i := 0
			for _, ch := range part {
				i = i*10 + int(ch-'0')
			}
			if i >= len(node) {
				t.Fatalf("path %q: index %s out of range in %s", path, part, body)
			}
			v = node[i]
		default:
			t.Fatalf("path %q: cannot descend into %v at %q; body=%s", path, v, part, body)
		}
	}
	return v
}

func bkString(t *testing.T, body []byte, path string) string {
	t.Helper()
	s, _ := bkPath(t, body, path).(string)
	return s
}

func bkLen(t *testing.T, body []byte, path string) int {
	t.Helper()
	a, ok := bkPath(t, body, path).([]any)
	if !ok {
		t.Fatalf("path %q is not an array: %s", path, body)
	}
	return len(a)
}

func bkMoveIn(t *testing.T, e *testEnv, folderID, docID, principal string) {
	t.Helper()
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents", `{"document_id":"`+docID+`"}`, bkHeaders(principal))
	assertStatus(t, rr, http.StatusOK)
}

// bookFixture makes a book folder holding "02 · B", "00 · Roadmap", "01 · A"
// and "Notes", then makes the folder a book.
type bookFixture struct {
	e                       *testEnv
	owner, folderID, bookID string
	roadmap, a, b, notes    string
	createStatus            int
	createBody              []byte
	outlineVersion          string
}

func newBookFixture(t *testing.T) bookFixture {
	t.Helper()
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	f := bookFixture{e: e, owner: principalHeader(fixtureOwner)}
	f.folderID = createFolder(t, e, `{"title":"Guide"}`, f.owner)
	mk := func(title string) string {
		id, _ := e.createDocument(title, "<html><body>"+title+"</body></html>", fixtureOwner)
		bkMoveIn(t, e, f.folderID, id, f.owner)
		return id
	}
	f.b = mk("02 · B")
	f.roadmap = mk("00 · Roadmap")
	f.a = mk("01 · A")
	f.notes = mk("Notes")
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+f.folderID+"/book", `{}`, bkHeaders(f.owner))
	f.createStatus, f.createBody = rr.Code, rr.Body.Bytes()
	if rr.Code == http.StatusCreated {
		f.bookID = bkString(t, rr.Body.Bytes(), "book_id")
		f.outlineVersion = bkString(t, rr.Body.Bytes(), "outline_version_id")
	}
	return f
}

func TestBooksDisabledByDefault(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	f := createFolder(t, e, `{"title":"B"}`, owner)
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+f+"/book", `{}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusNotFound)
	if got := bkString(t, rr.Body.Bytes(), "error.code"); got != "feature_disabled" {
		t.Fatalf("error.code = %q, want feature_disabled", got)
	}
}

func TestEveryBookRouteHonoursTheFlag(t *testing.T) {
	e := newTestEnv(t) // BooksEnabled defaults to false
	owner := principalHeader(fixtureOwner)
	f := createFolder(t, e, `{"title":"B"}`, owner)
	routes := []struct{ method, path, body string }{
		{http.MethodPost, "/v1/folders/" + f + "/book", `{}`},
		{http.MethodGet, "/v1/folders/" + f + "/book", ""},
		{http.MethodDelete, "/v1/books/book_x", ""},
		{http.MethodGet, "/v1/books/book_x/outline", ""},
		{http.MethodPut, "/v1/books/book_x/outline", `{"base_version_id":"x","outline":{"title":"T"}}`},
		{http.MethodGet, "/v1/books/book_x/outline/versions", ""},
		{http.MethodGet, "/v1/books/book_x/status", ""},
		{http.MethodGet, "/v1/books/book_x", ""},
		{http.MethodGet, "/v1/books/book_x/llms.txt", ""},
		{http.MethodGet, "/v1/books/book_x/state", ""},
		{http.MethodPut, "/v1/books/book_x/position", `{}`},
		{http.MethodPost, "/v1/books/book_x/seen", ""},
		{http.MethodGet, "/v1/books/book_x/search?q=x", ""},
		{http.MethodPost, "/v1/books/book_x/chapters/doc_x/open", `{}`},
		{http.MethodPost, "/v1/books/book_x/chapters/doc_x/progress", `{}`},
		{http.MethodPut, "/v1/books/book_x/chapters/doc_x/done", `{"done":true}`},
		{http.MethodPost, "/v1/books/book_x/chapters/doc_x/seen", ""},
		{http.MethodGet, "/v1/books/book_x/chapters/doc_x/changes", ""},
	}
	for _, r := range routes {
		t.Run(r.method+" "+r.path, func(t *testing.T) {
			rr := do(t, e.h, r.method, r.path, r.body, bkHeaders(owner))
			assertStatus(t, rr, http.StatusNotFound)
			if got := bkString(t, rr.Body.Bytes(), "error.code"); got != "feature_disabled" {
				t.Fatalf("error.code = %q, want feature_disabled", got)
			}
		})
	}
}

func TestCreateBookSeedsFromTitles(t *testing.T) {
	f := newBookFixture(t)
	if f.createStatus != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", f.createStatus, f.createBody)
	}
	if n := bkLen(t, f.createBody, "placed"); n != 3 {
		t.Fatalf("placed has %d ids, want 3: %s", n, f.createBody)
	}
	if n := bkLen(t, f.createBody, "not_in_outline"); n != 1 {
		t.Fatalf("not_in_outline has %d items, want 1: %s", n, f.createBody)
	}
	if got := bkString(t, f.createBody, "not_in_outline.0.id"); got != f.notes {
		t.Fatalf("not_in_outline id = %q, want %q", got, f.notes)
	}
	if got := bkString(t, f.createBody, "not_in_outline.0.title"); got != "Notes" {
		t.Fatalf("not_in_outline title = %q, want Notes", got)
	}

	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/outline", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.Bytes()
	if bkLen(t, body, "outline.front") != 1 || bkString(t, body, "outline.front.0.doc") != f.roadmap {
		t.Fatalf("front should be [roadmap]: %s", body)
	}
	if bkLen(t, body, "outline.parts.0.chapters") != 2 ||
		bkString(t, body, "outline.parts.0.chapters.0.doc") != f.a ||
		bkString(t, body, "outline.parts.0.chapters.1.doc") != f.b {
		t.Fatalf("chapters should be [A, B]: %s", body)
	}
	if bkString(t, body, "version_id") != f.outlineVersion {
		t.Fatalf("version_id = %q, want %q", bkString(t, body, "version_id"), f.outlineVersion)
	}
	if bkLen(t, body, "removed") != 0 {
		t.Fatalf("removed should be empty: %s", body)
	}

	rr = do(t, f.e.h, http.MethodGet, "/v1/folders/"+f.folderID+"/book", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	if got := bkString(t, rr.Body.Bytes(), "book_id"); got != f.bookID {
		t.Fatalf("folder book_id = %q, want %q", got, f.bookID)
	}
}

func TestCreateBookTwiceConflicts(t *testing.T) {
	f := newBookFixture(t)
	rr := do(t, f.e.h, http.MethodPost, "/v1/folders/"+f.folderID+"/book", `{}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusConflict)
	if got := bkString(t, rr.Body.Bytes(), "error.code"); got != "book_exists" {
		t.Fatalf("error.code = %q, want book_exists", got)
	}
	// The editor is told which book it is, so an agent can carry on with it.
	if got := bkString(t, rr.Body.Bytes(), "error.details.book_id"); got != f.bookID {
		t.Fatalf("error.details.book_id = %q, want %q", got, f.bookID)
	}
}

func TestFolderBookIsNotFoundWhenFolderIsNotABook(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	owner := principalHeader(fixtureOwner)
	f := createFolder(t, e, `{"title":"Plain"}`, owner)
	rr := do(t, e.h, http.MethodGet, "/v1/folders/"+f+"/book", "", bkHeaders(owner))
	assertStatus(t, rr, http.StatusNotFound)
}

func TestOutlineRequiresFolderEditor(t *testing.T) {
	f := newBookFixture(t)
	viewer := principalHeader(fixtureViewer)
	rr := do(t, f.e.h, http.MethodPost, "/v1/folders/"+f.folderID+"/grants",
		`{"address":"`+fixtureViewer.Email+`","role":"viewer"}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusCreated)

	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/outline", "", bkHeaders(viewer))
	assertStatus(t, rr, http.StatusForbidden)
	rr = do(t, f.e.h, http.MethodPut, "/v1/books/"+f.bookID+"/outline",
		`{"base_version_id":"`+f.outlineVersion+`","outline":{"title":"T"}}`, bkHeaders(viewer))
	assertStatus(t, rr, http.StatusForbidden)
	for _, path := range []string{"/outline/versions", "/status"} {
		rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+path, "", bkHeaders(viewer))
		assertStatus(t, rr, http.StatusForbidden)
	}
	rr = do(t, f.e.h, http.MethodDelete, "/v1/books/"+f.bookID, "", bkHeaders(viewer))
	assertStatus(t, rr, http.StatusForbidden)
	rr = do(t, f.e.h, http.MethodPost, "/v1/folders/"+f.folderID+"/book", `{}`, bkHeaders(viewer))
	assertStatus(t, rr, http.StatusForbidden)

	rr = do(t, f.e.h, http.MethodGet, "/v1/folders/"+f.folderID+"/book", "", bkHeaders(viewer))
	assertStatus(t, rr, http.StatusOK)

	// A caller with no grant cannot even look the book up.
	stranger := principalHeader(fixtureStranger)
	rr = do(t, f.e.h, http.MethodGet, "/v1/folders/"+f.folderID+"/book", "", bkHeaders(stranger))
	assertStatus(t, rr, http.StatusForbidden)

	// The editor routes answer a caller with no role on the folder as if the
	// book did not exist, so they cannot confirm a book id.
	for _, r := range []struct{ method, path, body string }{
		{http.MethodGet, "/outline", ""},
		{http.MethodPut, "/outline", `{"base_version_id":"` + f.outlineVersion + `","outline":{"title":"T"}}`},
		{http.MethodGet, "/outline/versions", ""},
		{http.MethodGet, "/status", ""},
		{http.MethodDelete, "", ""},
	} {
		rr = do(t, f.e.h, r.method, "/v1/books/"+f.bookID+r.path, r.body, bkHeaders(stranger))
		assertStatus(t, rr, http.StatusNotFound)
		missing := do(t, f.e.h, r.method, "/v1/books/book_missing"+r.path, r.body, bkHeaders(stranger))
		if missing.Body.String() != rr.Body.String() {
			t.Fatalf("%s %s: an existing book answers %s, a missing one %s", r.method, r.path, rr.Body.String(), missing.Body.String())
		}
	}
}

func TestMissingBookIsNotFound(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	rr := do(t, e.h, http.MethodGet, "/v1/books/book_missing/outline", "", bkHeaders(principalHeader(fixtureOwner)))
	assertStatus(t, rr, http.StatusNotFound)
}

func TestPutOutlineValidationAndConflict(t *testing.T) {
	pushed := scrapeMetric(t, "slashdocs_book_events_total", map[string]string{"event": "outline_pushed"})
	conflicts := scrapeMetric(t, "slashdocs_book_events_total", map[string]string{"event": "outline_conflict"})
	f := newBookFixture(t)
	put := func(body string) *httptest.ResponseRecorder {
		return do(t, f.e.h, http.MethodPut, "/v1/books/"+f.bookID+"/outline", body, bkHeaders(f.owner))
	}

	rr := put(`{"base_version_id":"` + f.outlineVersion + `","outline":{"title":"Guide","front":[],"parts":[{"title":"","chapters":[{"doc":"doc_missing"}]}],"back":[]}}`)
	assertStatus(t, rr, http.StatusUnprocessableEntity)
	if got := bkString(t, rr.Body.Bytes(), "error.code"); got != "invalid_outline" {
		t.Fatalf("error.code = %q, want invalid_outline", got)
	}
	if got := bkString(t, rr.Body.Bytes(), "error.details.problems.0.path"); got != "parts[0].chapters[0].doc" {
		t.Fatalf("problems[0].path = %q", got)
	}

	valid := `"outline":{"title":"Guide","front":[],"parts":[{"title":"","chapters":[{"doc":"` + f.b + `"},{"doc":"` + f.a + `"}]}],"back":[]}`
	rr = put(`{"base_version_id":"` + f.outlineVersion + `",` + valid + `,"note":"swap"}`)
	assertStatus(t, rr, http.StatusOK)
	if n := bkPath(t, rr.Body.Bytes(), "number"); n != float64(2) {
		t.Fatalf("number = %v, want 2: %s", n, rr.Body.Bytes())
	}
	current := bkString(t, rr.Body.Bytes(), "version_id")

	// The first version is now stale.
	rr = put(`{"base_version_id":"` + f.outlineVersion + `",` + valid + `}`)
	assertStatus(t, rr, http.StatusConflict)
	if got := bkString(t, rr.Body.Bytes(), "error.code"); got != "outline_conflict" {
		t.Fatalf("error.code = %q, want outline_conflict", got)
	}
	if got := bkString(t, rr.Body.Bytes(), "error.details.current_version_id"); got != current {
		t.Fatalf("current_version_id = %q, want %q", got, current)
	}

	if got := scrapeMetric(t, "slashdocs_book_events_total", map[string]string{"event": "outline_pushed"}); got != pushed+1 {
		t.Fatalf("outline_pushed = %v, want %v", got, pushed+1)
	}
	if got := scrapeMetric(t, "slashdocs_book_events_total", map[string]string{"event": "outline_conflict"}); got != conflicts+1 {
		t.Fatalf("outline_conflict = %v, want %v", got, conflicts+1)
	}

	// Non-JSON bodies are refused.
	rr = do(t, f.e.h, http.MethodPut, "/v1/books/"+f.bookID+"/outline", "x", map[string]string{"X-Test-Principal": f.owner, "Content-Type": "text/plain"})
	assertStatus(t, rr, http.StatusUnsupportedMediaType)

	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/outline/versions", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	if n := bkLen(t, rr.Body.Bytes(), "items"); n != 2 {
		t.Fatalf("versions = %d, want 2: %s", n, rr.Body.Bytes())
	}
	if got := bkString(t, rr.Body.Bytes(), "items.0.change_note"); got != "swap" {
		t.Fatalf("newest change_note = %q, want swap", got)
	}
}

func TestStatusReportsRemovedAfterDelete(t *testing.T) {
	f := newBookFixture(t)
	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/status", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	if n := bkLen(t, rr.Body.Bytes(), "entries"); n != 3 {
		t.Fatalf("entries = %d, want 3: %s", n, rr.Body.Bytes())
	}
	if got := bkString(t, rr.Body.Bytes(), "entries.1.title"); got != "A" {
		t.Fatalf("chapter title = %q, want A", got)
	}

	rr = do(t, f.e.h, http.MethodDelete, "/v1/documents/"+f.a, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusNoContent)

	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/status", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.Bytes()
	if n := bkLen(t, body, "entries"); n != 2 {
		t.Fatalf("entries after delete = %d, want 2: %s", n, body)
	}
	// The store writes a new outline version when a chapter is deleted (A10),
	// so the read-time filter finds nothing left to remove.
	if n := bkLen(t, body, "removed"); n != 0 {
		t.Fatalf("removed = %d, want 0 after the store pruned the outline: %s", n, body)
	}
	if strings.Contains(string(body), f.a) {
		t.Fatalf("deleted chapter still listed: %s", body)
	}
}

func TestDeleteBook(t *testing.T) {
	f := newBookFixture(t)
	rr := do(t, f.e.h, http.MethodDelete, "/v1/books/"+f.bookID, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusNoContent)
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/outline", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusNotFound)
	rr = do(t, f.e.h, http.MethodGet, "/v1/folders/"+f.folderID+"/book", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusNotFound)
}
