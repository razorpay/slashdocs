package server_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

// manifestFixture makes a folder with "01 · A", "02 · B" and "03 · C", and a
// book over it.
type manifestFixture struct {
	e                       *testEnv
	owner, folderID, bookID string
	a, b, c                 string
}

func newManifestFixture(t *testing.T) manifestFixture {
	t.Helper()
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	f := manifestFixture{e: e, owner: principalHeader(fixtureOwner)}
	f.folderID = createFolder(t, e, `{"title":"Guide"}`, f.owner)
	mk := func(title string) string {
		id, _ := e.createDocument(title, "<html><body><h1>"+title+"</h1><p>some words here</p></body></html>", fixtureOwner)
		bkMoveIn(t, e, f.folderID, id, f.owner)
		return id
	}
	f.a, f.b, f.c = mk("01 · A"), mk("02 · Zebra"), mk("03 · C")
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+f.folderID+"/book", `{}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusCreated)
	f.bookID = bkString(t, rr.Body.Bytes(), "book_id")
	return f
}

func (f manifestFixture) grantDoc(t *testing.T, docID, address string) {
	t.Helper()
	rr := do(t, f.e.h, http.MethodPost, "/v1/documents/"+docID+"/grants",
		`{"address":"`+address+`","role":"viewer"}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusCreated)
}

func TestManifestHidesChaptersReaderCannotOpen(t *testing.T) {
	f := newManifestFixture(t)
	f.grantDoc(t, f.a, fixtureViewer.Email)
	f.grantDoc(t, f.c, fixtureViewer.Email)

	viewer := principalHeader(fixtureViewer)
	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(viewer))
	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.Bytes()
	if n := bkLen(t, body, "readingOrder"); n != 2 {
		t.Fatalf("readingOrder has %d entries, want 2: %s", n, body)
	}
	if got := bkString(t, body, "readingOrder.0.href"); got != "/app/b/"+f.bookID+"/c/"+f.a {
		t.Fatalf("readingOrder[0].href = %q", got)
	}
	if got := bkString(t, body, "readingOrder.1.href"); got != "/app/b/"+f.bookID+"/c/"+f.c {
		t.Fatalf("readingOrder[1].href = %q", got)
	}
	// A11: canonical chapter URLs contain /c/doc_.
	if !strings.Contains(bkString(t, body, "readingOrder.0.href"), "/c/doc_") {
		t.Fatalf("href is not canonical: %s", body)
	}
	if strings.Contains(string(body), f.b) || strings.Contains(string(body), "Zebra") {
		t.Fatalf("body leaks the hidden chapter: %s", body)
	}
	for path, want := range map[string]float64{
		"readingOrder.0.properties.number": 1, "readingOrder.1.properties.number": 3,
		"toc.0.children.0.properties.number": 1, "toc.0.children.1.properties.number": 3,
	} {
		if got := bkPath(t, body, path); got != want {
			t.Fatalf("%s = %v, want %v: %s", path, got, want, body)
		}
	}
	if bkLen(t, body, "toc.0.children") != 2 {
		t.Fatalf("toc should hold only the visible chapters: %s", body)
	}
	// Only the chapters this reader can open are counted (R21).
	if n := bkPath(t, body, "metadata.numberOfChapters"); n != float64(2) {
		t.Fatalf("numberOfChapters = %v, want 2", n)
	}
	if got := bkPath(t, body, "metadata.canEdit"); got != false {
		t.Fatalf("canEdit = %v, want false", got)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}

	stranger := bkHeaders(principalHeader(fixtureStranger))
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", stranger)
	assertStatus(t, rr, http.StatusNotFound)
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/llms.txt", "", stranger)
	assertStatus(t, rr, http.StatusNotFound)
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/llms.txt", "", bkHeaders(viewer))
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), f.b) || strings.Contains(rr.Body.String(), "Zebra") {
		t.Fatalf("llms.txt leaks the hidden chapter:\n%s", rr.Body.String())
	}

	// The owner sees all three and can edit.
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	if n := bkLen(t, rr.Body.Bytes(), "readingOrder"); n != 3 {
		t.Fatalf("owner readingOrder = %d, want 3", n)
	}
	if got := bkPath(t, rr.Body.Bytes(), "metadata.canEdit"); got != true {
		t.Fatalf("owner canEdit = %v, want true", got)
	}
}

func TestManifestNumbersPlaceholdersAndStripsPrefixes(t *testing.T) {
	f := newManifestFixture(t)
	// Outline: A (1), planned "Later" (2), C (3).
	outline := `{"title":"Guide","front":[],"parts":[{"title":"One","chapters":[{"doc":"` + f.a + `"},{"planned":"Later"},{"doc":"` + f.c + `"}]}],"back":[]}`
	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/outline", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	base := bkString(t, rr.Body.Bytes(), "version_id")
	rr = do(t, f.e.h, http.MethodPut, "/v1/books/"+f.bookID+"/outline",
		`{"base_version_id":"`+base+`","outline":`+outline+`}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)

	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.Bytes()
	if bkLen(t, body, "toc.0.children") != 3 {
		t.Fatalf("toc children = %d, want 3: %s", bkLen(t, body, "toc.0.children"), body)
	}
	if bkPath(t, body, "toc.0.children.1.properties.number") != float64(2) ||
		bkString(t, body, "toc.0.children.1.properties.kind") != "planned" ||
		bkString(t, body, "toc.0.children.1.title") != "Later" {
		t.Fatalf("planned child wrong: %s", body)
	}
	if h := bkPath(t, body, "toc.0.children.1.href"); h != nil {
		t.Fatalf("planned child has href %v", h)
	}
	if bkPath(t, body, "toc.0.children.2.properties.number") != float64(3) ||
		bkString(t, body, "toc.0.children.2.title") != "C" {
		t.Fatalf("chapter 3 should be titled C: %s", body)
	}
	if bkLen(t, body, "readingOrder") != 2 {
		t.Fatalf("readingOrder should hold only real chapters: %s", body)
	}
	if bkPath(t, body, "metadata.numberOfChapters") != float64(3) {
		t.Fatalf("numberOfChapters should count the placeholder: %s", body)
	}
}

// A reader who cannot open a whole part learns nothing about it: the count
// leaves its chapters out and the part numbers index the reader's own toc.
// Chapter numbers stay the same for every reader (R7), and placeholders are
// shown to every reader.
func TestManifestCountsAndPartsFollowTheReadersView(t *testing.T) {
	f := newManifestFixture(t)
	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/outline", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	base := bkString(t, rr.Body.Bytes(), "version_id")
	outline := `{"title":"Guide","front":[],"parts":[` +
		`{"title":"Hidden part","chapters":[{"doc":"` + f.b + `"}]},` +
		`{"title":"Two","chapters":[{"doc":"` + f.a + `"},{"doc":"` + f.c + `"}]},` +
		`{"title":"Three","chapters":[{"planned":"Soon"}]}],"back":[]}`
	rr = do(t, f.e.h, http.MethodPut, "/v1/books/"+f.bookID+"/outline",
		`{"base_version_id":"`+base+`","outline":`+outline+`}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	f.grantDoc(t, f.a, fixtureViewer.Email)
	f.grantDoc(t, f.c, fixtureViewer.Email)

	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(principalHeader(fixtureViewer)))
	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.Bytes()
	if strings.Contains(string(body), "Hidden part") {
		t.Fatalf("manifest names the hidden part: %s", body)
	}
	for path, want := range map[string]any{
		"metadata.numberOfChapters":          float64(3),
		"toc.0.title":                        "Two",
		"toc.0.children.0.properties.part":   float64(0),
		"toc.0.children.0.properties.number": float64(2),
		"toc.0.children.1.properties.part":   float64(0),
		"toc.1.title":                        "Three",
		"toc.1.children.0.properties.part":   float64(1),
		"toc.1.children.0.properties.number": float64(4),
		"readingOrder.0.properties.part":     float64(0),
		"readingOrder.1.properties.part":     float64(0),
	} {
		if got := bkPath(t, body, path); got != want {
			t.Fatalf("%s = %v, want %v: %s", path, got, want, body)
		}
	}

	// The owner sees every part, numbered as in the outline.
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	body = rr.Body.Bytes()
	if bkPath(t, body, "metadata.numberOfChapters") != float64(4) || bkPath(t, body, "toc.1.children.0.properties.part") != float64(1) ||
		bkPath(t, body, "toc.2.children.0.properties.part") != float64(2) {
		t.Fatalf("owner manifest: %s", body)
	}
}

// A reader with chapter grants only is not told the folder, as the
// document API does not show them its parent folder. A folder viewer is.
func TestManifestNamesTheFolderOnlyToFolderViewers(t *testing.T) {
	f := newManifestFixture(t)
	f.grantDoc(t, f.a, fixtureViewer.Email)
	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(principalHeader(fixtureViewer)))
	assertStatus(t, rr, http.StatusOK)
	if got := bkPath(t, rr.Body.Bytes(), "metadata.folderId"); got != nil || strings.Contains(rr.Body.String(), f.folderID) {
		t.Fatalf("manifest names the folder to a chapter-only reader: %s", rr.Body.String())
	}

	rr = do(t, f.e.h, http.MethodPost, "/v1/folders/"+f.folderID+"/grants",
		`{"address":"`+fixtureStranger.Email+`","role":"viewer"}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusCreated)
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(principalHeader(fixtureStranger)))
	assertStatus(t, rr, http.StatusOK)
	if got := bkString(t, rr.Body.Bytes(), "metadata.folderId"); got != f.folderID {
		t.Fatalf("folderId = %q for a folder viewer, want %q", got, f.folderID)
	}
}

func TestLLMsTxtListsVisibleChapters(t *testing.T) {
	f := newManifestFixture(t)
	f.grantDoc(t, f.a, fixtureViewer.Email)
	f.grantDoc(t, f.c, fixtureViewer.Email)
	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/llms.txt", "", bkHeaders(principalHeader(fixtureViewer)))
	assertStatus(t, rr, http.StatusOK)
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("Content-Type = %q, want text/plain", ct)
	}
	text := rr.Body.String()
	if !strings.HasPrefix(text, "# Guide\n\n- [1 · A]") || strings.Contains(text, ">") {
		t.Fatalf("llms.txt should be a title, a blank line, then chapters only:\n%s", text)
	}
	for _, want := range []string{
		"# Guide\n",
		"- [1 · A](/app/b/" + f.bookID + "/c/" + f.a + ")",
		"- [3 · C](/app/b/" + f.bookID + "/c/" + f.c + ")",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("llms.txt missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, f.b) || strings.Contains(text, "Zebra") {
		t.Fatalf("llms.txt leaks the hidden chapter:\n%s", text)
	}
}

// A title cannot add a link of its own to llms.txt, which agents read and
// follow.
func TestLLMsTxtEscapesTitles(t *testing.T) {
	f := newManifestFixture(t)
	rr := do(t, f.e.h, http.MethodPatch, "/v1/documents/"+f.c, `{"title":"03 · x](https://evil.example/steal) [y \\"}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/outline", "", bkHeaders(f.owner))
	base := bkString(t, rr.Body.Bytes(), "version_id")
	outline := `{"title":"[Guide](https://evil.example/)","front":[],"parts":[{"title":"","chapters":[{"doc":"` + f.a + `"},{"doc":"` + f.b + `"},{"doc":"` + f.c + `"}]}],"back":[]}`
	rr = do(t, f.e.h, http.MethodPut, "/v1/books/"+f.bookID+"/outline", `{"base_version_id":"`+base+`","outline":`+outline+`}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)

	rr = do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID+"/llms.txt", "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	text := rr.Body.String()
	for _, want := range []string{
		"# \\[Guide\\]\\(https://evil.example/\\)\n",
		"- [3 · x\\]\\(https://evil.example/steal\\) \\[y \\\\](/app/b/" + f.bookID + "/c/" + f.c + ")\n",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("llms.txt missing %q:\n%s", want, text)
		}
	}
}

func TestManifestJSONShape(t *testing.T) {
	f := newManifestFixture(t)
	rr := do(t, f.e.h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.Bytes()
	for _, path := range []string{
		"@context", "metadata.identifier", "metadata.title", "metadata.folderId",
		"metadata.outlineVersionId", "metadata.numberOfChapters", "metadata.canEdit",
		"readingOrder.0.properties.documentId", "readingOrder.0.properties.kind",
		"readingOrder.0.title", "toc.0.title",
	} {
		if bkPath(t, body, path) == nil {
			t.Fatalf("manifest is missing %q: %s", path, body)
		}
	}
	if got := bkString(t, body, "metadata.identifier"); got != f.bookID {
		t.Fatalf("identifier = %q, want %q", got, f.bookID)
	}
	if got := bkString(t, body, "@context"); got != "https://readium.org/webpub-manifest/context.jsonld" {
		t.Fatalf("@context = %q", got)
	}
}

func TestManifestFolderViewerSeesBookWithOnlyPlannedEntries(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	owner := principalHeader(fixtureOwner)
	folderID := createFolder(t, e, `{"title":"Plans"}`, owner)
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/book", `{}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusCreated)
	bookID := bkString(t, rr.Body.Bytes(), "book_id")
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
		`{"address":"`+fixtureViewer.Email+`","role":"viewer"}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusCreated)
	rr = do(t, e.h, http.MethodGet, "/v1/books/"+bookID+"/outline", "", bkHeaders(owner))
	base := bkString(t, rr.Body.Bytes(), "version_id")
	rr = do(t, e.h, http.MethodPut, "/v1/books/"+bookID+"/outline",
		`{"base_version_id":"`+base+`","outline":{"title":"Plans","front":[],"parts":[{"title":"","chapters":[{"planned":"Soon"}]}],"back":[]}}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusOK)

	for _, path := range []string{"", "/llms.txt"} {
		rr = do(t, e.h, http.MethodGet, "/v1/books/"+bookID+path, "", bkHeaders(principalHeader(fixtureViewer)))
		assertStatus(t, rr, http.StatusOK)
	}
	rr = do(t, e.h, http.MethodGet, "/v1/books/"+bookID, "", bkHeaders(principalHeader(fixtureViewer)))
	if bkPath(t, rr.Body.Bytes(), "metadata.numberOfChapters") != float64(1) || bkLen(t, rr.Body.Bytes(), "readingOrder") != 0 {
		t.Fatalf("unexpected manifest: %s", rr.Body.Bytes())
	}
}

// ensureCounter counts EnsureVersionSections calls.
type ensureCounter struct {
	repo.Repository
	calls []string
}

func (r *ensureCounter) EnsureVersionSections(ctx context.Context, id string) error {
	r.calls = append(r.calls, id)
	return r.Repository.EnsureVersionSections(ctx, id)
}

func TestManifestOnlyIndexesUnindexedVersions(t *testing.T) {
	f := newManifestFixture(t)
	counter := &ensureCounter{Repository: f.e.store}
	h := server.New(server.Config{Environment: "test", BooksEnabled: true},
		server.WithRepository(counter), server.WithAuthenticator(testPrincipalAuth{})).Handler()

	// Everything is indexed already: the manifest must not call Ensure.
	if _, err := f.e.store.IndexVersionSections(context.Background()); err != nil {
		t.Fatalf("index: %v", err)
	}
	rr := do(t, h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	if len(counter.calls) != 0 {
		t.Fatalf("Ensure called for indexed versions: %v", counter.calls)
	}

	// Un-index one chapter: only that version is indexed again.
	doc, err := f.e.store.GetDocument(context.Background(), f.c)
	if err != nil {
		t.Fatalf("get document: %v", err)
	}
	pool := f.e.store.Pool()
	if _, err := pool.Exec(context.Background(), `DELETE FROM version_sections WHERE version_id = $1`, doc.CurrentVersionID); err != nil {
		t.Fatalf("delete sections: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE versions SET sections_indexed = false WHERE id = $1`, doc.CurrentVersionID); err != nil {
		t.Fatalf("unindex: %v", err)
	}
	rr = do(t, h, http.MethodGet, "/v1/books/"+f.bookID, "", bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusOK)
	if len(counter.calls) != 1 || counter.calls[0] != doc.CurrentVersionID {
		t.Fatalf("Ensure calls = %v, want only %s", counter.calls, doc.CurrentVersionID)
	}
	if got := bkPath(t, rr.Body.Bytes(), "readingOrder.2.properties.wordCount"); got == nil || got == float64(0) {
		t.Fatalf("re-indexed chapter has no word count: %s", rr.Body.Bytes())
	}
}
