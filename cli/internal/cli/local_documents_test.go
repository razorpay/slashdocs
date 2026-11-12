package cli

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestLocalDocumentsCLI runs `slashdocs docs` commands on a local server at
// slashdocs.localhost, which the client sends to this machine.
func TestLocalDocumentsCLI(t *testing.T) {
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
	srv.Config.Handler = localHandler(root, info, localPrincipal{Type: "user", ID: "ada"})
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
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(dir, name))
		return err == nil
	}
	file := filepath.Join(t.TempDir(), "plan.html")
	v1, v2 := "<title>Q3 plan</title><h2>Rollout</h2>", "<title>Q3 plan</title><h2>Rollout</h2><p>Dates</p>"
	writeTestFile(t, file, []byte(v1))

	if out := sd("docs", "create", file); !strings.Contains(out, info.URL+"/app/d/plan.html") || !exists("plan.html") {
		t.Fatalf("create = %q", out)
	}
	if out := sd("docs", "list", "q3"); !strings.Contains(out, "Q3 plan") || exists(".plan.html.slashdocs.json") {
		t.Errorf("list = %q, want the <title> and no state file", out)
	}
	notes := filepath.Join(t.TempDir(), "notes.html")
	writeTestFile(t, notes, []byte("<title>Old</title>"))
	writeTestFile(t, filepath.Join(dir, ".notes.html.slashdocs.json"), []byte(`{"comments":[{"id":"old","body":"From another file"}]}`))
	if _, err := Execute([]string{"--server", info.URL, "docs", "create", notes}); err == nil {
		t.Error("create took the comments of an old state file")
	}
	if err := os.Remove(filepath.Join(dir, ".notes.html.slashdocs.json")); err != nil {
		t.Fatal(err)
	}
	sd("docs", "create", notes, "--title", "Team notes")
	if out := sd("docs", "show", "notes.html"); !strings.Contains(out, "title=Team notes") {
		t.Errorf("show after create --title = %q", out)
	}
	sd("docs", "update", "notes.html", "--title", "Notes")
	if out := sd("docs", "list", "notes"); !strings.Contains(out, "title=Notes ") {
		t.Errorf("list after update --title = %q", out)
	}
	if state := readTestFile(t, filepath.Join(dir, ".notes.html.slashdocs.json")); !strings.Contains(string(state), `"title": "Notes"`) {
		t.Errorf("state file = %s", state)
	}
	writeTestFile(t, file, []byte(v2))
	sd("docs", "push", "plan.html", file) // the base version is from create
	if out := sd("docs", "pull", "plan.html"); out != v2 {
		t.Errorf("pull = %q, want %q", out, v2)
	}
	if out := sd("--json", "docs", "headings", "plan.html"); !strings.Contains(out, info.URL+"/plan.html#rollout") {
		t.Errorf("headings = %q", out)
	}
	sd("docs", "comments", "create", "plan.html", "--body", "Why?", "--quote", "Rollout", "--version", localVersion([]byte(v2)))

	sd("docs", "move", "plan.html", "--folder-id", "archive")
	if !exists("archive/plan.html") || !exists("archive/.plan.html.slashdocs.json") {
		t.Fatal("move did not move the document and its comments to archive/")
	}
	sd("docs", "move", "archive/plan.html", "--root")
	sd("docs", "delete", "plan.html")
	if exists("plan.html") || exists(".plan.html.slashdocs.json") {
		t.Error("delete left the document or its comments")
	}

	if _, err := Execute([]string{"--server", info.URL, "docs", "grants", "list", "x.html"}); err == nil || !strings.Contains(err.Error(), "does not support") {
		t.Errorf("grants list error = %v, want the unsupported message", err)
	}
}

func TestLocalDocumentErrors(t *testing.T) {
	l := newTestLocal(t)
	report := localVersion(readTestFile(t, filepath.Join(l.dir, "report.html")))
	for _, tt := range []struct {
		method, target string
		status         int
	}{
		{http.MethodGet, "/v1/documents/chart.png", http.StatusNotFound},
		{http.MethodGet, "/v1/documents/report.html/versions/" + report + "/html", http.StatusOK},
		{http.MethodGet, "/v1/documents/report.html/versions/old/html", http.StatusNotFound},
		{http.MethodGet, "/v1/documents/report.html/link?comment=missing", http.StatusNotFound},
		{http.MethodDelete, "/v1/folders/specs/documents/report.html", http.StatusNotFound},
		{http.MethodPost, "/v1/documents/report.html/grants", http.StatusNotImplemented},
		{http.MethodGet, "/app/d/specs%2Fapi.htm?comment=c1", http.StatusFound},
	} {
		if w := l.do(tt.method, testApp, tt.target, ""); w.Code != tt.status {
			t.Errorf("%s %s = %d %s, want %d", tt.method, tt.target, w.Code, w.Body, tt.status)
		}
	}
	if w := l.do(http.MethodGet, testApp, "/app/d/specs%2Fapi.htm?comment=c1", ""); w.Header().Get("Location") != "http://"+testApp+"/specs/api.htm?comment=c1" {
		t.Errorf("app link goes to %q", w.Header().Get("Location"))
	}
	if w := l.do(http.MethodGet, testApp, "/v1/documents/report.html/versions/"+report+"/html", ""); !strings.HasPrefix(w.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("document HTML has no sandbox: %v", w.Header())
	}
}

func TestLocalFlag(t *testing.T) {
	_, err := Execute([]string{"--local", "--server", "https://docs.example.com", "docs", "list"})
	if ExitCode(err) != 2 {
		t.Errorf("--local with --server: %v (exit %d), want a usage error", err, ExitCode(err))
	}
	t.Setenv("SLASHDOCS_TOKEN", "secret")
	c, err := client(&globals{local: true, server: "http://slashdocs.localhost"})
	if err != nil || c.Token != "" || c.Base != "http://slashdocs.localhost" {
		t.Errorf("--local client = %+v, %v; want the local server and no token", c, err)
	}
}

// TestLocalState covers the state files that a person or an agent edits, and
// the files around a document.
func TestLocalState(t *testing.T) {
	l := newTestLocal(t)
	write := func(name, data string) {
		p := filepath.Join(l.dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		writeTestFile(t, p, []byte(data))
	}
	write(".report.html.slashdocs.json", `{"comments":[null]}`)
	write("specs/.release #2.html.slashdocs.json", `{"comments":[{"id":"c","replies":[{"id":"r","replies":[null]}]}]}`)
	write("dest/.report.html.slashdocs.json", `{"title":"Other"}`) // without its document
	if err := os.Symlink(filepath.Join(t.TempDir(), "outside.html"), filepath.Join(l.dir, "outside.html")); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		method, target, body string
		status               int
	}{
		{http.MethodGet, "/v1/documents/report.html/comments", "", http.StatusInternalServerError},
		{http.MethodGet, "/v1/documents/specs%2Frelease%20%232.html/comments", "", http.StatusInternalServerError},
		{http.MethodGet, "/v1/documents", "", http.StatusOK}, // without the link out of the folder
		{http.MethodPost, "/v1/folders/dest/documents", `{"document_id":"report.html"}`, http.StatusConflict},
		{http.MethodPost, "/v1/folders/.git/documents", `{"document_id":"report.html"}`, http.StatusBadRequest},
		{http.MethodGet, "/v1/documents/.draft.html", "", http.StatusNotFound},
		{http.MethodGet, "/_/raw/.draft.html", "", http.StatusNotFound},
		{http.MethodGet, "/_/api/entry/.draft.html", "", http.StatusNotFound},
	} {
		if w := l.do(tt.method, testApp, tt.target, tt.body); w.Code != tt.status {
			t.Errorf("%s %s = %d %s, want %d", tt.method, tt.target, w.Code, w.Body, tt.status)
		}
	}

	sidecar := filepath.Join(l.dir, "specs", ".api.htm.slashdocs.json")
	l.do(http.MethodPatch, testApp, "/v1/documents/specs%2Fapi.htm", `{"title":"API"}`)
	if err := os.Chmod(sidecar, 0o600); err != nil {
		t.Fatal(err)
	}
	l.do(http.MethodPatch, testApp, "/v1/documents/specs%2Fapi.htm", `{"title":"API v2"}`)
	if st, err := os.Stat(sidecar); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("state file mode after a change = %v, %v; want 0600", st, err)
	}
	l.do(http.MethodPatch, testApp, "/v1/documents/specs%2Fapi.htm", `{"title":" "}`)
	if _, err := os.Stat(sidecar); !os.IsNotExist(err) {
		t.Errorf("state file without a title or comments: %v, want it removed", err)
	}
}
