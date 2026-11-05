package cli

import (
	"encoding/json"
	"fmt"
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
	if err == nil || ExitCode(err) != 5 {
		t.Fatalf("err = %v, exit %d", err, ExitCode(err))
	}
	for _, want := range []string{"changed since version bov_1", "now bov_9", "slashdocs books outline pull book_1"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("conflict message lacks %q: %v", want, err)
		}
	}
}

// outlineServer answers PUT /outline like the server: 409 outline_conflict
// unless the base is the current version, else a new version.
func outlineServer(t *testing.T) *httptest.Server {
	t.Helper()
	current, number := "bov_1", 1
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Base string `json:"base_version_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		w.Header().Set("Content-Type", "application/json")
		if in.Base != current {
			// The server's 409 outline_conflict envelope.
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":{"code":"outline_conflict","message":"Someone saved a newer outline. Reload it and apply your changes again.","details":{"current_version_id":"` + current + `"}}}`))
			return
		}
		number++
		current = fmt.Sprintf("bov_%d", number)
		_, _ = fmt.Fprintf(w, `{"version_id":%q,"number":%d}`, current, number)
	}))
}

const pulledOutline = `{"version_id":"bov_1","number":1,"outline":{"title":"B","parts":[]},"not_in_outline":[],"removed":[]}`

// A successful push moves the pulled file to the version it created, so the
// same file can be edited and pushed again without a conflict.
func TestBooksOutlinePushUpdatesThePulledFile(t *testing.T) {
	srv := outlineServer(t)
	defer srv.Close()
	booksEnv(t, srv)
	f := bookFile(t, "pulled.json", pulledOutline)
	if _, err := Execute([]string{"books", "outline", "push", "book_1", f}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(f) //nolint:gosec // The test reads the file it wrote under t.TempDir.
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		VersionID string          `json:"version_id"`
		Number    int             `json:"number"`
		Outline   json.RawMessage `json:"outline"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("pushed file is not JSON: %v\n%s", err, b)
	}
	if got.VersionID != "bov_2" || got.Number != 2 || !strings.Contains(string(got.Outline), `"title": "B"`) {
		t.Fatalf("pushed file = %s, want version bov_2 (2) with the outline kept", b)
	}
	if strings.Index(string(b), `"version_id"`) > strings.Index(string(b), `"outline"`) {
		t.Errorf("pushed file reorders its fields:\n%s", b)
	}
	if _, err := Execute([]string{"books", "outline", "push", "book_1", f}); err != nil {
		t.Fatalf("second push of the same file: %v", err)
	}
}

// Two files pulled at the same version: pushing the second after the first
// is a real conflict, whoever pushed the first, so it gets the generic
// message and no advice to force the push.
func TestBooksOutlinePushFromAnotherFileGetsTheGenericConflict(t *testing.T) {
	srv := outlineServer(t)
	defer srv.Close()
	booksEnv(t, srv)
	a := bookFile(t, "a.json", pulledOutline)
	bf := bookFile(t, "b.json", pulledOutline)
	if _, err := Execute([]string{"books", "outline", "push", "book_1", a}); err != nil {
		t.Fatal(err)
	}
	_, err := Execute([]string{"books", "outline", "push", "book_1", bf})
	if err == nil || ExitCode(err) != 5 {
		t.Fatalf("second file push err = %v, exit %d, want conflict", err, ExitCode(err))
	}
	for _, want := range []string{"changed since version bov_1 (now bov_2)", "slashdocs books outline pull book_1"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("conflict message lacks %q: %v", want, err)
		}
	}
	for _, bad := range []string{"--base-version", "you pushed"} {
		if strings.Contains(err.Error(), bad) {
			t.Errorf("conflict message says %q: %v", bad, err)
		}
	}
}

func TestBooksOutlinePullWritesFileOrStdout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/books/book_1/outline" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeTestJSON(t, w, map[string]any{"version_id": "bov_1", "number": 1, "outline": map[string]any{"title": "B"}, "not_in_outline": []any{}, "removed": []any{}})
	}))
	defer srv.Close()
	booksEnv(t, srv)
	out, err := Execute([]string{"books", "outline", "pull", "book_1"})
	if err != nil || !strings.Contains(out, `"version_id": "bov_1"`) {
		t.Fatalf("stdout pull = %q, %v", out, err)
	}
	dest := filepath.Join(t.TempDir(), "o.json")
	out, err = Execute([]string{"books", "outline", "pull", "book_1", dest})
	if err != nil {
		t.Fatal(err)
	}
	if want := "\u2713 Pulled outline version 1 (bov_1) of book_1 to " + dest + "."; strings.TrimSpace(out) != want {
		t.Fatalf("file pull output = %q, want %q", out, want)
	}
	if out, err := Execute([]string{"books", "outline", "pull", "book_1", dest, "--quiet"}); err != nil || out != "" {
		t.Fatalf("quiet pull = %q, %v", out, err)
	}
	b, err := os.ReadFile(dest) //nolint:gosec // The test reads the file it just wrote under t.TempDir.
	if err != nil || !strings.Contains(string(b), `"outline"`) {
		t.Fatalf("file = %q, %v", b, err)
	}
}

func TestBooksCreateShowDelete(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/folders/fld_1/book":
			w.WriteHeader(http.StatusCreated)
			writeTestJSON(t, w, map[string]any{"book_id": "book_1", "outline_version_id": "bov_1"})
		case "GET /v1/books/book_1":
			intro := map[string]any{"title": "Intro", "properties": map[string]any{"documentId": "doc_a", "kind": "chapter", "number": 1}}
			writeTestJSON(t, w, map[string]any{"metadata": map[string]any{"title": "Guide", "numberOfChapters": 1}, "readingOrder": []any{intro}, "toc": []any{map[string]any{"title": "", "children": []any{intro}}}})
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
	if out, err := Execute([]string{"books", "delete", "book_1"}); err != nil || !strings.Contains(out, "book_1") {
		t.Fatalf("delete = %q, %v", out, err)
	}
	if len(seen) != 3 {
		t.Fatalf("requests = %v", seen)
	}
}

// bookStatusBody has the shape of the server's bookStatusResponse
// (handlers_books.go bookStatus): a front-matter doc, a chapter, a placeholder,
// a document the outline does not place and a removed id.
const bookStatusBody = `{"entries":[` +
	`{"kind":"front","number":0,"document_id":"doc_r","title":"Roadmap","current_version_id":"ver_r1","planned":false},` +
	`{"kind":"chapter","number":1,"document_id":"doc_a","title":"Intro","current_version_id":"ver_a2","planned":false},` +
	`{"kind":"planned","number":2,"title":"Pricing","planned":true}],` +
	`"not_in_outline":[{"id":"doc_n","title":"Notes"}],"removed":["doc_gone"]}`

func TestBooksStatusRendersChaptersAndLeftovers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/books/book_1/status" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(bookStatusBody))
	}))
	defer srv.Close()
	booksEnv(t, srv)
	out, err := Execute([]string{"books", "status", "book_1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "map[") {
		t.Fatalf("status printed a Go map:\n%s", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	want := [][]string{
		{"Outline:"},
		{"front", "Roadmap", "doc_r", "ver_r1"},
		{"1", "Intro", "doc_a", "ver_a2"},
		{"2", "Pricing", "planned"},
		{"Not in outline:"},
		{"doc_n", "Notes"},
		{"Removed from the outline:"},
		{"doc_gone"},
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d:\n%s", len(lines), len(want), out)
	}
	for i, fields := range want {
		if got := strings.Fields(lines[i]); strings.Join(got, " ") != strings.Join(fields, " ") {
			t.Errorf("line %d = %q, want fields %v", i, lines[i], fields)
		}
	}

	out, err = Execute([]string{"books", "status", "book_1", "--json"})
	if err != nil || !strings.Contains(out, `"not_in_outline"`) || !strings.Contains(out, `"current_version_id": "ver_a2"`) {
		t.Fatalf("--json status = %q, %v", out, err)
	}
}

func TestBooksStatusOfAnEmptyBook(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"entries":[],"not_in_outline":[],"removed":[]}`))
	}))
	defer srv.Close()
	booksEnv(t, srv)
	out, err := Execute([]string{"books", "status", "book_1"})
	if err != nil || strings.TrimSpace(out) != "The outline is empty." {
		t.Fatalf("status = %q, %v", out, err)
	}
}

func TestBooksCreateListsPlacedAndUnplacedDocuments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The shape of the server's createBookResponse.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"book_id":"book_1","outline_version_id":"bov_1","placed":["doc_r","doc_a","doc_b"],"not_in_outline":[{"id":"doc_n","title":"Notes"}]}`))
	}))
	defer srv.Close()
	booksEnv(t, srv)
	out, err := Execute([]string{"books", "create", "fld_1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Created book book_1 from folder fld_1", "3 documents placed", "1 not in the outline", "doc_n", "Notes", "slashdocs books status book_1"} {
		if !strings.Contains(out, want) {
			t.Errorf("create output lacks %q:\n%s", want, out)
		}
	}
}

func TestBooksCreateOnABookNamesIt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"book_exists","message":"This folder is already a book.","details":{"book_id":"book_7"}}}`))
	}))
	defer srv.Close()
	booksEnv(t, srv)
	_, err := Execute([]string{"books", "create", "fld_1"})
	if err == nil || ExitCode(err) != 5 || !strings.Contains(err.Error(), "book_7") || !strings.Contains(err.Error(), "slashdocs books show book_7") {
		t.Fatalf("err = %v, exit %d", err, ExitCode(err))
	}
}

// bookManifestBody has the shape of the server's manifestResponse
// (handlers_book_manifest.go): front and back matter, one chapter the reader
// can open, and a placeholder, which only the toc lists.
const bookManifestBody = `{"@context":"https://readium.org/webpub-manifest/context.jsonld",` +
	`"metadata":{"identifier":"book_1","title":"Guide","numberOfChapters":2,"folderId":"fld_1","outlineVersionId":"bov_1","canEdit":true},` +
	`"links":[{"href":"/v1/books/book_1","type":"application/json","title":"Manifest","rel":"self"}],` +
	`"readingOrder":[` +
	`{"href":"/app/b/book_1/c/doc_r","type":"text/html","title":"Roadmap","properties":{"documentId":"doc_r","kind":"front","part":-1,"versionId":"ver_r1"}},` +
	`{"href":"/app/b/book_1/c/doc_a","type":"text/html","title":"Intro","properties":{"documentId":"doc_a","kind":"chapter","number":1,"part":0,"versionId":"ver_a2","wordCount":120}},` +
	`{"href":"/app/b/book_1/c/doc_z","type":"text/html","title":"Afterword","properties":{"documentId":"doc_z","kind":"back","part":-1,"versionId":"ver_z1"}}],` +
	`"toc":[{"title":"Basics","children":[{"href":"/app/b/book_1/c/doc_a","type":"text/html","title":"Intro","properties":{"documentId":"doc_a","kind":"chapter","number":1,"part":0}},` +
	`{"title":"Pricing","properties":{"kind":"planned","number":2,"part":0}}]}]}`

func TestBooksShowFindsTheBookOfAFolder(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/folders/fld_1/book":
			_, _ = w.Write([]byte(`{"book_id":"book_1"}`))
		case "/v1/books/book_1":
			_, _ = w.Write([]byte(bookManifestBody))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	booksEnv(t, srv)
	out, err := Execute([]string{"books", "show", "--folder", "fld_1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(seen, ",") != "GET /v1/folders/fld_1/book,GET /v1/books/book_1" {
		t.Fatalf("requests = %v", seen)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	want := [][]string{
		{"Guide", "(book_1,", "2", "chapters)"},
		{"front", "Roadmap", "doc_r"},
		{"Basics"},
		{"1", "Intro", "doc_a"},
		{"2", "Pricing", "planned"},
		{"back", "Afterword", "doc_z"},
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d:\n%s", len(lines), len(want), out)
	}
	for i, fields := range want {
		if got := strings.Fields(lines[i]); strings.Join(got, " ") != strings.Join(fields, " ") {
			t.Errorf("line %d = %q, want fields %v", i, lines[i], fields)
		}
	}
	if out, err := Execute([]string{"books", "show", "--folder", "fld_1", "--json"}); err != nil || !strings.Contains(out, `"identifier": "book_1"`) {
		t.Fatalf("--json show = %q, %v", out, err)
	}
}

func TestBooksShowNeedsABookOrAFolder(t *testing.T) {
	for _, args := range [][]string{
		{"books", "show"},
		{"books", "show", "book_1", "--folder", "fld_1"},
	} {
		if _, err := Execute(args); ExitCode(err) != 2 {
			t.Errorf("%v: err = %v, exit %d, want usage error", args, err, ExitCode(err))
		}
	}
}

func TestBooksOutlinePushRejectsBadFiles(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	booksEnv(t, srv)
	for name, tc := range map[string]struct {
		contents string
		exit     int
		want     string
	}{
		"not JSON":     {"{", 2, "not valid JSON"},
		"array":        {"[]", 2, "must be a JSON object"},
		"null":         {"null", 2, "must be a JSON object"},
		"no such file": {"", 1, "no such file"},
	} {
		t.Run(name, func(t *testing.T) {
			f := filepath.Join(t.TempDir(), "missing.json")
			if tc.contents != "" {
				f = bookFile(t, "outline.json", tc.contents)
			}
			_, err := Execute([]string{"books", "outline", "push", "book_1", f, "--base-version", "bov_1"})
			if ExitCode(err) != tc.exit || err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "Go value") {
				t.Fatalf("err = %v, exit %d, want exit %d and %q", err, ExitCode(err), tc.exit, tc.want)
			}
		})
	}
}
