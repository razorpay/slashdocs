package cli

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// upload sends a new document to the local server from the app page.
func (l testLocal) upload(t *testing.T, name, html string, fields map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := form.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	file, err := form.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(html)); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/v1/documents", &body)
	r.Host = testApp
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Header.Set("Origin", "http://"+testApp)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	l.h.ServeHTTP(w, r)
	return w
}

// state reads the state file of a document. It reports false when the
// document has none.
func (l testLocal) state(t *testing.T, doc string) (localState, bool) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(l.dir, filepath.FromSlash(sidecarPath(doc))))
	if os.IsNotExist(err) {
		return localState{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	var s localState
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("the state file of %s is %q: %v", doc, b, err)
	}
	return s, true
}

// docs is the store of the documents folder of l, as the server has it.
func (l testLocal) docs(t *testing.T) *localDocs {
	t.Helper()
	root, err := os.OpenRoot(l.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return &localDocs{root: root, me: localPrincipal{Type: "user", ID: "ada"}, url: localURL(7070)}
}

// expire gives a document a state file with an expiry time, and makes the
// file as old as written.
func (l testLocal) expire(t *testing.T, doc string, expiresAt, written time.Time) {
	t.Helper()
	b, err := json.Marshal(localState{ExpiresAt: expiresAt.UTC(), Comments: []*localComment{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(l.dir, filepath.FromSlash(sidecarPath(doc))), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(l.dir, filepath.FromSlash(doc)), written, written); err != nil {
		t.Fatal(err)
	}
}

func (l testLocal) has(name string) bool {
	_, err := os.Lstat(filepath.Join(l.dir, filepath.FromSlash(name)))
	return err == nil
}

// trashed returns the files in the trash, without the folder of the sweep.
func (l testLocal) trashed(t *testing.T) []string {
	t.Helper()
	var files []string
	trash := filepath.Join(l.dir, localTrash)
	err := filepath.WalkDir(trash, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(trash, p)
		if err != nil {
			return err
		}
		_, name, _ := strings.Cut(filepath.ToSlash(rel), "/")
		files = append(files, name)
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	slices.Sort(files)
	return files
}

func assertLocalExpiresIn(t *testing.T, at time.Time, period time.Duration) {
	t.Helper()
	if off := time.Until(at) - period; off < -time.Minute || off > time.Minute {
		t.Fatalf("the expiry %s is %v from now, want %v", at, time.Until(at).Round(time.Second), period)
	}
}

const localDay = 24 * time.Hour

func TestLocalCreateKeepsTheExpiryInTheStateFile(t *testing.T) {
	l := newTestLocal(t)
	w := l.upload(t, "scratch.html", "<title>Scratch</title>", map[string]string{"title": "scratch.html", "expires_in": "7d"})
	created := decodeTest[localDocument](t, w)
	assertLocalExpiresIn(t, created.ExpiresAt, 7*localDay)

	// The state file holds only the expiry: the document has no comment and
	// no title of its own.
	state, ok := l.state(t, "scratch.html")
	if !ok || !state.ExpiresAt.Equal(created.ExpiresAt) || state.Title != "" {
		t.Fatalf("the state file is %+v, %v, want only the expiry %s", state, ok, created.ExpiresAt)
	}
	got := decodeTest[localDocument](t, l.do(http.MethodGet, testApp, "/v1/documents/scratch.html", ""))
	if !got.ExpiresAt.Equal(created.ExpiresAt) || got.Title != "Scratch" {
		t.Fatalf("GET gave %+v", got)
	}
	list := decodeTest[struct{ Items []localDocument }](t, l.do(http.MethodGet, testApp, "/v1/documents?q=scratch", ""))
	if len(list.Items) != 1 || !list.Items[0].ExpiresAt.Equal(created.ExpiresAt) {
		t.Fatalf("the list gave %+v", list.Items)
	}
	// The app reads the folder from its own route.
	root := decodeTest[localEntry](t, l.do(http.MethodGet, testApp, "/_/api/entry/", ""))
	for _, e := range root.Entries {
		if (e.Path == "scratch.html") != !e.ExpiresAt.IsZero() {
			t.Errorf("the entry %s has the expiry %s", e.Path, e.ExpiresAt)
		}
	}
	if kept := decodeTest[localDocument](t, l.do(http.MethodGet, testApp, "/v1/documents/report.html", "")); !kept.ExpiresAt.IsZero() {
		t.Fatalf("a document with no expiry has %s", kept.ExpiresAt)
	}
	if strings.Contains(l.do(http.MethodGet, testApp, "/v1/documents/report.html", "").Body.String(), "expires_at") {
		t.Fatal("the response of a document that is kept holds expires_at")
	}
}

func TestLocalCreateRefusesAWrongExpiry(t *testing.T) {
	l := newTestLocal(t)
	for _, fields := range []map[string]string{
		{"expires_in": "3m"},
		{"expires_at": "2020-01-01T00:00:00Z"},
		{"expires_in": "7d", "expires_at": time.Now().Add(localDay).UTC().Format(time.RFC3339)},
	} {
		if w := l.upload(t, "wrong.html", "<p>wrong</p>", fields); w.Code != http.StatusBadRequest {
			t.Errorf("a create with %v gave %d %s, want 400", fields, w.Code, w.Body)
		}
	}
	if l.has("wrong.html") {
		t.Fatal("a create with a wrong expiry made the file")
	}
}

func TestLocalPatchSetsAndRemovesTheExpiry(t *testing.T) {
	l := newTestLocal(t)
	patch := func(body string) *httptest.ResponseRecorder {
		return l.do(http.MethodPatch, testApp, "/v1/documents/report.html", body)
	}
	set := decodeTest[localDocument](t, patch(`{"expires_in":"1d"}`))
	assertLocalExpiresIn(t, set.ExpiresAt, localDay)
	// A state file with only an expiry stays. Before, a state with no title
	// and no comment had no file.
	if state, ok := l.state(t, "report.html"); !ok || !state.ExpiresAt.Equal(set.ExpiresAt) {
		t.Fatalf("the state file is %+v, %v", state, ok)
	}

	at := time.Now().Add(3 * localDay).UTC().Truncate(time.Second)
	if got := decodeTest[localDocument](t, patch(`{"expires_at":"`+at.Format(time.RFC3339)+`"}`)); !got.ExpiresAt.Equal(at) {
		t.Fatalf("PATCH gave the expiry %s, want %s", got.ExpiresAt, at)
	}
	// A rename keeps the expiry.
	if got := decodeTest[localDocument](t, patch(`{"title":"Renamed"}`)); got.Title != "Renamed" || !got.ExpiresAt.Equal(at) {
		t.Fatalf("a rename gave %+v", got)
	}
	if got := decodeTest[localDocument](t, patch(`{"title":"","expires_at":null}`)); !got.ExpiresAt.IsZero() || got.Title != "Q3 & plan" {
		t.Fatalf("a null gave %+v, want no expiry and the title of the HTML", got)
	}
	if _, ok := l.state(t, "report.html"); ok {
		t.Fatal("a document with no title, comment or expiry still has a state file")
	}
	for name, body := range map[string]string{
		"nothing":             `{}`,
		"a bare m":            `{"expires_in":"3m"}`,
		"a period and a null": `{"expires_in":"7d","expires_at":null}`,
		"an empty time":       `{"expires_at":""}`,
		"a time in the past":  `{"expires_at":"2020-01-01T00:00:00Z"}`,
	} {
		if w := patch(body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: PATCH gave %d %s, want 400", name, w.Code, w.Body)
		}
	}
}

func TestLocalExpiryStaysWhenTheLastCommentGoes(t *testing.T) {
	l := newTestLocal(t)
	decodeTest[localDocument](t, l.do(http.MethodPatch, testApp, "/v1/documents/report.html", `{"expires_in":"1d"}`))
	comment := decodeTest[localComment](t, l.do(http.MethodPost, testApp, "/v1/documents/report.html/comments", `{"body":"a note","anchor":{"quote":"plan"}}`))
	if w := l.do(http.MethodDelete, testApp, "/v1/documents/report.html/comments/"+comment.ID, ""); w.Code >= 300 {
		t.Fatalf("delete comment = %d %s", w.Code, w.Body)
	}
	if state, ok := l.state(t, "report.html"); !ok || state.ExpiresAt.IsZero() || len(state.Comments) != 0 {
		t.Fatalf("after the last comment went the state file is %+v, %v, want the expiry", state, ok)
	}
}

func TestRemoveExpiredMovesTheDocumentAndItsStateToTheTrash(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	l.expire(t, "report.html", now.Add(-time.Minute), now.Add(-time.Hour))
	l.expire(t, "specs/api.htm", now.Add(localDay), now.Add(-time.Hour))

	moved, err := l.docs(t).removeExpired(now)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(moved, []string{"report.html"}) {
		t.Fatalf("removeExpired moved %q, want report.html", moved)
	}
	if l.has("report.html") || l.has(sidecarPath("report.html")) {
		t.Fatal("the expired document or its state file is still in the folder")
	}
	// The state held only the expiry, so it holds nothing now and has no
	// file in the trash.
	if got, want := l.trashed(t), []string{"report.html"}; !slices.Equal(got, want) {
		t.Fatalf("the trash holds %q, want %q", got, want)
	}
	// A document with a later expiry, and documents with no state, stay.
	for _, kept := range []string{"specs/api.htm", sidecarPath("specs/api.htm"), "specs/release #2.html", ".draft.html", "chart.png"} {
		if !l.has(kept) {
			t.Errorf("%s is gone", kept)
		}
	}
	if w := l.do(http.MethodGet, testApp, "/v1/documents/report.html", ""); w.Code != http.StatusNotFound {
		t.Fatalf("GET of the expired document gave %d", w.Code)
	}
	// The trash is hidden, so the documents in it are not documents.
	list := decodeTest[struct{ Items []localDocument }](t, l.do(http.MethodGet, testApp, "/v1/documents", ""))
	for _, d := range list.Items {
		if strings.Contains(d.ID, "report") {
			t.Errorf("the list holds %s", d.ID)
		}
	}
	// A second sweep finds nothing, also not in the trash.
	if moved, err := l.docs(t).removeExpired(now.Add(time.Hour)); err != nil || len(moved) != 0 {
		t.Fatalf("a second sweep moved %q, %v", moved, err)
	}
}

func TestRemoveExpiredKeepsADocumentInAFolder(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	l.expire(t, "specs/api.htm", now.Add(-time.Minute), now.Add(-time.Hour))
	if moved, err := l.docs(t).removeExpired(now); err != nil || !slices.Equal(moved, []string{"specs/api.htm"}) {
		t.Fatalf("removeExpired moved %q, %v", moved, err)
	}
	if got, want := l.trashed(t), []string{"specs/api.htm"}; !slices.Equal(got, want) {
		t.Fatalf("the trash holds %q, want the path of the document in it: %q", got, want)
	}
}

// A person takes a document back from the trash with its state file. The
// state in the trash has no expiry, so the document then stays.
func TestADocumentThatComesBackFromTheTrashIsKept(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	decodeTest[localDocument](t, l.do(http.MethodPatch, testApp, "/v1/documents/report.html", `{"title":"Named","expires_in":"1d"}`))
	l.expire(t, "report.html", now.Add(-time.Minute), now.Add(-time.Hour))
	state := localState{Title: "Named", ExpiresAt: now.Add(-time.Minute).UTC(), Comments: []*localComment{}}
	b, _ := json.Marshal(state)
	writeTestFile(t, filepath.Join(l.dir, ".report.html.slashdocs.json"), b)
	if moved, err := l.docs(t).removeExpired(now); err != nil || !slices.Equal(moved, []string{"report.html"}) {
		t.Fatalf("removeExpired moved %q, %v", moved, err)
	}
	if got, want := l.trashed(t), []string{".report.html.slashdocs.json", "report.html"}; !slices.Equal(got, want) {
		t.Fatalf("the trash holds %q, want the document and its state: %q", got, want)
	}
	// Move the two files back, as a person does.
	matches, _ := filepath.Glob(filepath.Join(l.dir, localTrash, "*", "*"))
	for _, from := range matches {
		if err := os.Rename(from, filepath.Join(l.dir, filepath.Base(from))); err != nil {
			t.Fatal(err)
		}
	}
	back, ok := l.state(t, "report.html")
	if !ok || back.Title != "Named" || !back.ExpiresAt.IsZero() {
		t.Fatalf("the state that came back is %+v, %v, want the title and no expiry", back, ok)
	}
	if moved, err := l.docs(t).removeExpired(now.Add(time.Hour)); err != nil || len(moved) != 0 {
		t.Fatalf("the sweep moved the document that came back: %q, %v", moved, err)
	}
	if !l.has("report.html") {
		t.Fatal("the document that came back is gone")
	}
}

// A person deletes a document by hand, and its state file stays. A new file
// with the same name must not take the expiry of the old one, so the sweep
// removes the expiry of a state file that has no document.
func TestRemoveExpiredForgetsTheExpiryOfADocumentThatIsGone(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	week := now.Add(7 * localDay).UTC()
	onlyExpiry, _ := json.Marshal(localState{ExpiresAt: week, Comments: []*localComment{}})
	withTitle, _ := json.Marshal(localState{Title: "Old notes", ExpiresAt: week, Comments: []*localComment{}})
	writeTestFile(t, filepath.Join(l.dir, ".gone.html.slashdocs.json"), onlyExpiry)
	writeTestFile(t, filepath.Join(l.dir, "specs", ".old.html.slashdocs.json"), withTitle)
	l.expire(t, "report.html", week, now.Add(-time.Hour)) // a document that is there keeps its expiry

	if moved, err := l.docs(t).removeExpired(now); err != nil || len(moved) != 0 {
		t.Fatalf("removeExpired moved %q, %v", moved, err)
	}
	if l.has(".gone.html.slashdocs.json") {
		t.Error("a state file that held only the expiry of a document that is gone is still there")
	}
	if state, ok := l.state(t, "specs/old.html"); !ok || state.Title != "Old notes" || !state.ExpiresAt.IsZero() {
		t.Errorf("the state of the document that is gone is %+v, %v, want the title and no expiry", state, ok)
	}
	if state, ok := l.state(t, "report.html"); !ok || !state.ExpiresAt.Equal(week) {
		t.Errorf("the document that is there lost its expiry: %+v, %v", state, ok)
	}
	// The new file with the old name is kept.
	writeTestFile(t, filepath.Join(l.dir, "gone.html"), []byte("<p>new</p>"))
	if moved, err := l.docs(t).removeExpired(week.Add(time.Hour)); err != nil || slices.Contains(moved, "gone.html") {
		t.Fatalf("the sweep moved the new file: %q, %v", moved, err)
	}
}

// The trash is a folder of the documents folder. A link in its place could
// send the documents to a folder that is listed.
func TestRemoveExpiredRefusesATrashThatIsALink(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	if err := os.Symlink(".", filepath.Join(l.dir, localTrash)); err != nil {
		t.Skip("this system has no symbolic links")
	}
	l.expire(t, "report.html", now.Add(-time.Minute), now.Add(-time.Hour))
	moved, err := l.docs(t).removeExpired(now)
	if err == nil || len(moved) != 0 {
		t.Fatalf("removeExpired moved %q, %v, want an error and nothing moved", moved, err)
	}
	if !l.has("report.html") {
		t.Fatal("the document is gone")
	}
}

// A sweep that cannot move a document leaves no empty folder in the trash,
// so a failure that lasts does not fill the trash with folders.
func TestASweepThatFailsLeavesNoEmptyFolder(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	l.expire(t, "specs/api.htm", now.Add(-time.Minute), now.Add(-time.Hour))
	// A folder with the name of the document is in the way of the move.
	docs := l.docs(t)
	stamp := now.UTC().Format(localTrashStamp)
	if err := os.MkdirAll(filepath.Join(l.dir, localTrash, stamp, "specs", "api.htm", "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if moved, err := docs.removeExpired(now); err == nil || len(moved) != 0 {
		t.Fatalf("removeExpired moved %q, %v, want an error", moved, err)
	}
	if !l.has("specs/api.htm") || !l.has(sidecarPath("specs/api.htm")) {
		t.Fatal("the document or its state file is gone after a move that failed")
	}
}

// The expiry belongs to a path. A file that changed after the expiry time is
// a new file with the name of an old one, or a document that a person worked
// on while the server was off. It stays, and its expiry goes.
func TestRemoveExpiredKeepsAFileThatChangedAfterItsExpiry(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	l.expire(t, "report.html", now.Add(-time.Hour), now.Add(-time.Minute))
	moved, err := l.docs(t).removeExpired(now)
	if err != nil || len(moved) != 0 {
		t.Fatalf("removeExpired moved %q, %v, want nothing", moved, err)
	}
	if !l.has("report.html") || len(l.trashed(t)) != 0 {
		t.Fatal("the file that changed after its expiry is in the trash")
	}
	if _, ok := l.state(t, "report.html"); ok {
		t.Fatal("the file that changed after its expiry still has the expiry")
	}
}

func TestRemoveExpiredLeavesLinksAndHiddenFolders(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	outside := filepath.Join(t.TempDir(), "outside.html")
	writeTestFile(t, outside, []byte("<p>outside</p>"))
	if err := os.Symlink(outside, filepath.Join(l.dir, "link.html")); err != nil {
		t.Skip("this system has no symbolic links")
	}
	if err := os.MkdirAll(filepath.Join(l.dir, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(l.dir, ".git", "page.html"), []byte("<p>hidden</p>"))
	old := now.Add(-time.Hour)
	for _, doc := range []string{"link.html", ".git/page.html"} {
		b, _ := json.Marshal(localState{ExpiresAt: now.Add(-time.Minute).UTC(), Comments: []*localComment{}})
		writeTestFile(t, filepath.Join(l.dir, filepath.FromSlash(sidecarPath(doc))), b)
	}
	if err := os.Chtimes(outside, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(l.dir, ".git", "page.html"), old, old); err != nil {
		t.Fatal(err)
	}
	moved, err := l.docs(t).removeExpired(now)
	if err != nil || len(moved) != 0 {
		t.Fatalf("removeExpired moved %q, %v, want nothing", moved, err)
	}
	if _, err := os.Stat(outside); err != nil || !l.has("link.html") || !l.has(".git/page.html") {
		t.Fatal("a link, the file that it names, or a file of a hidden folder is gone")
	}
}

// A person or an agent can edit a state file, so it can be wrong. Its
// document stays, the sweep goes on, and the document shows no expiry.
func TestRemoveExpiredKeepsADocumentWithAWrongStateFile(t *testing.T) {
	l := newTestLocal(t)
	now := time.Now()
	writeTestFile(t, filepath.Join(l.dir, ".report.html.slashdocs.json"), []byte(`{"expires_at": "yesterday"`))
	// This one has an expiry that passed, but a comment that cannot be.
	writeTestFile(t, filepath.Join(l.dir, "specs", ".release #2.html.slashdocs.json"), []byte(`{"expires_at":"2020-01-01T00:00:00Z","comments":[null]}`))
	if err := os.Chtimes(filepath.Join(l.dir, "specs", "release #2.html"), now.Add(-time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	root := decodeTest[localEntry](t, l.do(http.MethodGet, testApp, "/_/api/entry/specs", ""))
	for _, e := range root.Entries {
		if !e.ExpiresAt.IsZero() {
			t.Errorf("the entry %s with a wrong state file shows the expiry %s", e.Path, e.ExpiresAt)
		}
	}
	l.expire(t, "specs/api.htm", now.Add(-time.Minute), now.Add(-time.Hour))
	moved, err := l.docs(t).removeExpired(now)
	if err != nil || !slices.Equal(moved, []string{"specs/api.htm"}) {
		t.Fatalf("removeExpired moved %q, %v, want only specs/api.htm", moved, err)
	}
	if !l.has("report.html") || !l.has("specs/release #2.html") {
		t.Fatal("a document with a wrong state file is gone")
	}
}

// The docs commands of the CLI set the expiry of a local document.
func TestLocalExpiryThroughTheCLI(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	srv := httptest.NewUnstartedServer(nil)
	_, p, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(p)
	info := localInfo{URL: localURL(port), Port: port, Dir: dir}
	srv.Config.Handler = localHandler(root, fstest.MapFS{}, info, localPrincipal{Type: "user", ID: "ada"})
	srv.Start()
	t.Cleanup(srv.Close)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	sd := func(args ...string) string {
		t.Helper()
		out, err := Execute(append([]string{"--server", info.URL}, args...))
		if err != nil {
			t.Fatalf("slashdocs %s: %v", strings.Join(args, " "), err)
		}
		return out
	}
	file := filepath.Join(t.TempDir(), "plan.html")
	writeTestFile(t, file, []byte("<title>Plan</title>"))

	if out := sd("docs", "create", file, "--ttl", "7d"); !strings.Contains(out, "The server deletes it after") {
		t.Fatalf("create = %q", out)
	}
	if out := sd("docs", "show", "plan.html"); !strings.Contains(out, "expires_at=") {
		t.Fatalf("show = %q, want the expiry", out)
	}
	if out := sd("docs", "update", "plan.html", "--ttl", "never"); !strings.Contains(out, "has no expiry") {
		t.Fatalf("update = %q", out)
	}
	if _, err := os.Stat(filepath.Join(dir, ".plan.html.slashdocs.json")); !os.IsNotExist(err) {
		t.Fatalf("after never the document still has a state file: %v", err)
	}
	if out := sd("docs", "update", "plan.html", "--ttl", "1mo"); !strings.Contains(out, "The server deletes document plan.html after") {
		t.Fatalf("update = %q", out)
	}
}
