package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func booksEnv(t *testing.T, srv *httptest.Server) {
	t.Helper()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
}

func bookFile(t *testing.T, name, contents string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	writeTestFile(t, p, []byte(contents))
	return p
}

func TestBooksOutlinePushSendsBaseVersionAndNote(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PUT" || r.URL.Path != "/v1/books/book_1/outline" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode: %v", err)
		}
		writeTestJSON(t, w, map[string]any{"version_id": "bov_2", "number": 2})
	}))
	defer srv.Close()
	booksEnv(t, srv)
	f := bookFile(t, "outline.json", `{"title":"B","parts":[{"title":"I","chapters":[{"planned":"X"}]}]}`)
	if _, err := Execute([]string{"books", "outline", "push", "book_1", f, "--base-version", "bov_1", "--note", "add X"}); err != nil {
		t.Fatal(err)
	}
	if got["base_version_id"] != "bov_1" || got["note"] != "add X" {
		t.Fatalf("body = %#v", got)
	}
	if o, _ := got["outline"].(map[string]any); o["title"] != "B" {
		t.Fatalf("outline = %#v", got["outline"])
	}
}

func TestBooksOutlinePushAcceptsPulledJSON(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		writeTestJSON(t, w, map[string]any{"version_id": "bov_3", "number": 3})
	}))
	defer srv.Close()
	booksEnv(t, srv)
	f := bookFile(t, "pulled.json", `{"version_id":"bov_7","number":7,"outline":{"title":"B","parts":[]}}`)
	if _, err := Execute([]string{"books", "outline", "push", "book_1", f}); err != nil {
		t.Fatal(err)
	}
	if got["base_version_id"] != "bov_7" {
		t.Fatalf("base_version_id = %v, want bov_7", got["base_version_id"])
	}
	if o, _ := got["outline"].(map[string]any); o["title"] != "B" {
		t.Fatalf("outline = %#v", got["outline"])
	}
	// A bare outline without --base-version is a usage error.
	bare := bookFile(t, "bare.json", `{"title":"B"}`)
	_, err := Execute([]string{"books", "outline", "push", "book_1", bare})
	if err == nil || ExitCode(err) != 2 {
		t.Fatalf("err = %v, exit %d, want usage error", err, ExitCode(err))
	}
}

func TestBooksOutlinePushPrintsProblems(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":{"code":"invalid_outline","message":"The outline has problems.","details":{"problems":[{"path":"title","message":"Give the book a title."},{"path":"parts[0].title","message":"Name the part."}]}}}`))
	}))
	defer srv.Close()
	booksEnv(t, srv)
	f := bookFile(t, "outline.json", `{"title":""}`)
	_, err := Execute([]string{"books", "outline", "push", "book_1", f, "--base-version", "bov_1"})
	if err == nil || !strings.Contains(err.Error(), "title: Give the book a title.") || !strings.Contains(err.Error(), "parts[0].title: Name the part.") {
		t.Fatalf("err = %v", err)
	}
}

func TestBooksOutlinePushConflictExitsFive(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"outline_conflict","message":"x","details":{"current_version_id":"bov_9"}}}`))
	}))
	defer srv.Close()
	booksEnv(t, srv)
	f := bookFile(t, "outline.json", `{"title":"B"}`)
	_, err := Execute([]string{"books", "outline", "push", "book_1", f, "--base-version", "bov_1"})
	if err == nil || ExitCode(err) != 5 || !strings.Contains(err.Error(), "Pull again and re-apply your changes.") {
		t.Fatalf("err = %v, exit %d", err, ExitCode(err))
	}
}

func TestBooksOutlinePullWritesFileOrStdout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/books/book_1/outline" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeTestJSON(t, w, map[string]any{"version_id": "bov_1", "outline": map[string]any{"title": "B"}})
	}))
	defer srv.Close()
	booksEnv(t, srv)
	out, err := Execute([]string{"books", "outline", "pull", "book_1"})
	if err != nil || !strings.Contains(out, `"version_id": "bov_1"`) {
		t.Fatalf("stdout pull = %q, %v", out, err)
	}
	dest := filepath.Join(t.TempDir(), "o.json")
	if _, err := Execute([]string{"books", "outline", "pull", "book_1", dest}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(dest)
	if err != nil || !strings.Contains(string(b), `"outline"`) {
		t.Fatalf("file = %q, %v", b, err)
	}
}

func TestBooksCreateShowStatusDelete(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/folders/fld_1/book":
			w.WriteHeader(http.StatusCreated)
			writeTestJSON(t, w, map[string]any{"book_id": "book_1", "outline_version_id": "bov_1"})
		case "GET /v1/books/book_1":
			writeTestJSON(t, w, map[string]any{"metadata": map[string]any{"title": "Guide", "numberOfChapters": 1}, "readingOrder": []any{map[string]any{"title": "Intro", "properties": map[string]any{"documentId": "doc_a", "number": 1}}}})
		case "GET /v1/books/book_1/status":
			writeTestJSON(t, w, map[string]any{"ok": true})
		case "DELETE /v1/books/book_1":
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	booksEnv(t, srv)
	if out, err := Execute([]string{"books", "create", "fld_1"}); err != nil || !strings.Contains(out, "book_1") {
		t.Fatalf("create = %q, %v", out, err)
	}
	out, err := Execute([]string{"books", "show", "book_1"})
	if err != nil || !strings.Contains(out, "Guide") || !strings.Contains(out, "doc_a") || !strings.Contains(out, "Intro") {
		t.Fatalf("show = %q, %v", out, err)
	}
	if _, err := Execute([]string{"books", "status", "book_1"}); err != nil {
		t.Fatal(err)
	}
	if out, err := Execute([]string{"books", "delete", "book_1"}); err != nil || !strings.Contains(out, "book_1") {
		t.Fatalf("delete = %q, %v", out, err)
	}
	if len(seen) != 4 {
		t.Fatalf("requests = %v", seen)
	}
}
