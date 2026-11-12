package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	testApp    = localHost + ":7070"
	testRender = "127.0.0.1:7070"
)

type testLocal struct {
	dir string
	h   http.Handler
}

func newTestLocal(t *testing.T) testLocal {
	t.Helper()
	dir := t.TempDir()
	for name, data := range map[string]string{
		"report.html":           "<html><head><title>Q3 &amp; plan</title></head></html>",
		"specs/api.htm":         "<p>no title</p>",
		"specs/release #2.html": "<title>Release</title>",
		".draft.html":           "hidden",
		"chart.png":             "png",
		"empty/.keep":           "",
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	me := localPrincipal{Type: "user", ID: "ada", Name: "Ada"}
	return testLocal{dir, localHandler(root, localInfo{URL: localURL(7070), Port: 7070, Dir: "/docs"}, me)}
}

// do sends a request from the app page.
func (l testLocal) do(method, host, target, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Host = host
	if method != http.MethodGet {
		r.Header.Set("Origin", "http://"+testApp)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	w := httptest.NewRecorder()
	l.h.ServeHTTP(w, r)
	return w
}

func decodeTest[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if w.Code >= 300 || json.Unmarshal(w.Body.Bytes(), &v) != nil {
		t.Fatalf("response = %d %s", w.Code, w.Body)
	}
	return v
}

func TestLocalEntries(t *testing.T) {
	l := newTestLocal(t)
	entry := func(target string) localEntry {
		t.Helper()
		return decodeTest[localEntry](t, l.do(http.MethodGet, testApp, "/_/api/entry"+target, ""))
	}

	root := entry("/")
	if root.Title != "Documents" || root.Dir != "/docs" || len(root.Entries) != 3 {
		t.Fatalf("root = %+v", root)
	}
	if got := []string{root.Entries[0].Type, root.Entries[1].Type, root.Entries[2].Title}; strings.Join(got, ",") != "folder,folder,Q3 & plan" {
		t.Errorf("root entries = %v, want folders first, then titled documents", got)
	}
	if specs := entry("/specs"); specs.Dir != "/docs/specs" || len(specs.Entries) != 2 {
		t.Errorf("specs = %+v", specs)
	}
	if body := l.do(http.MethodGet, testApp, "/_/api/entry/empty", "").Body.String(); !strings.Contains(body, `"entries":[]`) {
		t.Errorf("empty folder = %s, want an empty entries list", body)
	}
	doc := entry("/specs/release%20%232.html")
	if doc.Type != "document" || doc.Title != "Release" || doc.Raw != "/_/raw/specs/release%20%232.html" || len(doc.Version) != 16 {
		t.Errorf("document = %+v", doc)
	}
	if untitled := entry("/specs/api.htm"); untitled.Title != "api" {
		t.Errorf("untitled document title = %q, want the file name", untitled.Title)
	}
	if csp := l.do(http.MethodGet, testApp, "/_/raw/report.html", "").Header().Get("Content-Security-Policy"); csp != "sandbox "+localSandbox {
		t.Errorf("raw CSP = %q", csp)
	}
}

func TestLocalHosts(t *testing.T) {
	l := newTestLocal(t)
	tests := []struct {
		name, host, target string
		status             int
	}{
		{"app", testApp, "/", http.StatusOK},
		{"asset", testApp, "/chart.png", http.StatusFound},
		{"missing entry", testApp, "/_/api/entry/missing.html", http.StatusNotFound},
		{"unsupported API", testApp, "/v1/config", http.StatusNotImplemented},
		{"other file entry", testApp, "/_/api/entry/chart.png", http.StatusNotFound},
		{"info for the CLI", testRender, "/_/info", http.StatusOK},
		{"app on the render origin", "[::1]:7070", "/specs", http.StatusFound},
		{"raw on the render origin", testRender, "/_/raw/report.html", http.StatusFound},
		{"render without a token", testRender, "/_/render/report.html", http.StatusNotFound},
		{"render on the app origin", testApp, "/_/render/report.html", http.StatusNotFound},
		{"other host", "evil.example:7070", "/", http.StatusForbidden},
	}
	for _, tt := range tests {
		if w := l.do(http.MethodGet, tt.host, tt.target, ""); w.Code != tt.status {
			t.Errorf("%s: status = %d, want %d", tt.name, w.Code, tt.status)
		}
	}
	if got := l.do(http.MethodGet, testRender, "/specs?x=1", "").Header().Get("Location"); got != "http://"+testApp+"/specs?x=1" {
		t.Errorf("render origin redirect = %q", got)
	}
}

func TestLocalRender(t *testing.T) {
	l := newTestLocal(t)
	id := url.PathEscape("specs/release #2.html")
	tok := decodeTest[struct{ URL string }](t, l.do(http.MethodPost, testApp, "/v1/documents/"+id+"/versions/abc/render-token", ""))
	u, err := url.Parse(tok.URL)
	if err != nil || u.Host != testRender || u.Path != "/_/render/specs/release #2.html" || u.Query().Get("v") != "abc" {
		t.Fatalf("render URL = %q", tok.URL)
	}
	w := l.do(http.MethodGet, testRender, u.RequestURI(), "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `id="slashdocs-doc"`) {
		t.Fatalf("render = %d %s", w.Code, w.Body)
	}
	if csp := w.Header().Get("Content-Security-Policy"); !strings.HasSuffix(csp, "frame-ancestors http://"+testApp) {
		t.Errorf("render CSP = %q, want only the app to frame it", csp)
	}
	other := strings.Replace(u.RequestURI(), "release%20%232.html", "api.htm", 1)
	if w := l.do(http.MethodGet, testRender, other, ""); w.Code != http.StatusNotFound {
		t.Errorf("render of another document with the token = %d, want 404", w.Code)
	}
}

func TestLocalComments(t *testing.T) {
	l := newTestLocal(t)
	base := "/v1/documents/" + url.PathEscape("specs/release #2.html") + "/comments"
	list := func() []localComment {
		t.Helper()
		return decodeTest[struct{ Items []localComment }](t, l.do(http.MethodGet, testApp, base, "")).Items
	}

	if got := list(); len(got) != 0 {
		t.Fatalf("comments before the first = %+v", got)
	}
	c := decodeTest[localComment](t, l.do(http.MethodPost, testApp, base, `{"version_id":"v1","body":"Why?","anchor":{"quote":"Release","start_offset":0,"end_offset":7}}`))
	if c.Author.ID != "ada" || c.Status != "open" || c.Anchor.Quote != "Release" || c.Version != "v1" {
		t.Fatalf("created = %+v", c)
	}
	reply := decodeTest[localComment](t, l.do(http.MethodPost, testApp, base+"/"+c.ID+"/replies", `{"body":"Because."}`))
	for _, tt := range []struct {
		method, target, body string
		status               int
	}{
		{http.MethodPut, base + "/" + c.ID + "/reactions/heart", "", http.StatusNoContent},
		{http.MethodPut, base + "/" + c.ID + "/reactions/heart", "", http.StatusNoContent}, // twice is once
		{http.MethodPut, base + "/" + c.ID + "/reactions/sparkles", "", http.StatusBadRequest},
		{http.MethodPatch, base + "/" + c.ID, `{"status":"resolved"}`, http.StatusOK},
		{http.MethodPatch, base + "/" + reply.ID, `{"status":"resolved"}`, http.StatusBadRequest},
		{http.MethodPatch, base + "/" + c.ID, `{"body":" "}`, http.StatusBadRequest},
		{http.MethodPost, base + "/" + reply.ID + "/replies", `{"body":"nested"}`, http.StatusNotFound},
		{http.MethodPost, base, `{"body":"no anchor"}`, http.StatusBadRequest},
		{http.MethodDelete, base + "/missing", "", http.StatusNotFound},
		{http.MethodGet, "/v1/documents/chart.png/comments", "", http.StatusNotFound},
	} {
		if w := l.do(tt.method, testApp, tt.target, tt.body); w.Code != tt.status {
			t.Errorf("%s %s = %d %s, want %d", tt.method, tt.target, w.Code, w.Body, tt.status)
		}
	}

	if got := list(); got[0].Edited || got[0].Replies[0].Edited {
		t.Fatal("status changes must not mark comments as edited")
	}
	for _, id := range []string{c.ID, reply.ID} {
		w := l.do(http.MethodPatch, testApp, base+"/"+id, `{"body":"Updated"}`)
		if w.Code != http.StatusOK || !decodeTest[localComment](t, w).Edited {
			t.Fatalf("edit %s = %d %s", id, w.Code, w.Body)
		}
	}
	if got := list(); !got[0].Edited || !got[0].Replies[0].Edited {
		t.Fatal("edited state did not persist")
	}

	open := decodeTest[struct{ Items []localComment }](t, l.do(http.MethodGet, testApp, base+"?status=open", "")).Items
	if len(open) != 0 {
		t.Errorf("open comments = %+v, want none", open)
	}
	got := list()
	if len(got) != 1 || got[0].Status != "resolved" || got[0].ResolvedAt.IsZero() || len(got[0].Replies) != 1 {
		t.Fatalf("comments = %+v", got)
	}
	if r := got[0].Reactions; len(r) != 1 || r[0].Count != 1 || !r[0].Reacted {
		t.Errorf("reactions = %+v, want one heart from the viewer", r)
	}
	sidecar, err := os.ReadFile(filepath.Join(l.dir, "specs", ".release #2.html.slashdocs.json"))
	if err != nil || strings.Contains(string(sidecar), `"count"`) || !strings.Contains(string(sidecar), `"body": "Updated"`) {
		t.Errorf("sidecar = %s, %v; want the comments without viewer fields", sidecar, err)
	}

	l.do(http.MethodDelete, testApp, base+"/"+reply.ID, "")
	l.do(http.MethodPatch, testApp, base+"/"+c.ID, `{"status":"open"}`)
	if got := list(); len(got[0].Replies) != 0 || got[0].Status != "open" || !got[0].ResolvedAt.IsZero() {
		t.Errorf("after delete and reopen = %+v", got[0])
	}
}

func TestLocalCommentsRefuseOtherOrigins(t *testing.T) {
	l := newTestLocal(t)
	r := httptest.NewRequest(http.MethodPost, "/v1/documents/report.html/comments", strings.NewReader(`{}`))
	r.Host = testApp
	r.Header.Set("Origin", "http://"+testRender) // a document script
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w := httptest.NewRecorder()
	l.h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("cross-origin write = %d, want 403", w.Code)
	}
}
