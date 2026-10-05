package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// decodeSingleJSON parses out as exactly one JSON value, failing when stdout is
// empty, not JSON, or carries anything after the first value.
func decodeSingleJSON(t *testing.T, out string) any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(out))
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("stdout is not a single JSON value (%v): %q", err, out)
	}
	if _, err := dec.Token(); err != io.EOF {
		t.Fatalf("stdout carries more than one JSON value: %q", out)
	}
	return v
}

// jsonObject asserts out is one JSON object and returns it.
func jsonObject(t *testing.T, out string) map[string]any {
	t.Helper()
	m, ok := decodeSingleJSON(t, out).(map[string]any)
	if !ok {
		t.Fatalf("stdout is not a JSON object: %q", out)
	}
	return m
}

// errorBodyOf asserts out is the --json error envelope and returns its body.
func errorBodyOf(t *testing.T, out string) map[string]any {
	t.Helper()
	m := jsonObject(t, out)
	body, ok := m["error"].(map[string]any)
	if !ok {
		t.Fatalf("stdout is not an error envelope: %q", out)
	}
	return body
}

// conflictServer answers every version create with the real 409
// version_conflict body, details included.
func conflictServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/versions") {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		requireMultipart(t, r)
		w.WriteHeader(http.StatusConflict)
		writeTestJSON(t, w, map[string]any{"error": map[string]any{
			"code":    "version_conflict",
			"message": "base_version_id is stale",
			"details": map[string]any{"current_version_id": "ver_9"},
		}})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// jsonTestEnv points the CLI at srv with throwaway config and home directories
// and returns the path of an HTML file the publish commands can upload.
func jsonTestEnv(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AIDOCS_TOKEN", "tok")
	t.Setenv("AIDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("AIDOCS_NO_BROWSER", "1")
	t.Setenv("AIDOCS_NO_KEYCHAIN", "1")
	t.Setenv("AIDOCS_DISABLE_AUTO_UPDATE", "1")
	// Store a logged-in context for srv as well, so commands that only act for
	// a server the user has logged in to (update, skills update) are exercised
	// here rather than refused.
	name := ctxName(srv.URL)
	if err := saveConfig(Config{ActiveContext: name, Contexts: map[string]*Context{name: {
		Server:     normalizeServer(srv.URL),
		Credential: map[string]any{"id": "cred_1", "token": "tok"},
		Pulled:     map[string]string{},
	}}}); err != nil {
		t.Fatalf("save logged-in context: %v", err)
	}
	html := filepath.Join(t.TempDir(), "report.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))
	return html
}

// TestJSONErrorEnvelopeCarriesServerDetails is the recovery case from issue
// #102: a caller must be able to read current_version_id off a 409 instead of
// parsing prose on stderr.
func TestJSONErrorEnvelopeCarriesServerDetails(t *testing.T) {
	srv := conflictServer(t)
	html := jsonTestEnv(t, srv)

	out, err := Execute([]string{"--json", "docs", "push", "doc_1", html, "--base-version", "ver_old"})
	if err == nil {
		t.Fatal("expected a version conflict")
	}
	if code := ExitCode(err); code != 5 {
		t.Fatalf("exit code = %d, want 5 (unchanged)", code)
	}
	body := errorBodyOf(t, out)
	if body["code"] != "version_conflict" {
		t.Fatalf("error.code = %v, want version_conflict (output %q)", body["code"], out)
	}
	if body["message"] != "base_version_id is stale" {
		t.Fatalf("error.message = %v (output %q)", body["message"], out)
	}
	if body["status"] != float64(http.StatusConflict) {
		t.Fatalf("error.status = %v, want 409 (output %q)", body["status"], out)
	}
	details, ok := body["details"].(map[string]any)
	if !ok || details["current_version_id"] != "ver_9" {
		t.Fatalf("error.details = %v, want current_version_id ver_9 (output %q)", body["details"], out)
	}
}

// TestVersionConflictTextNamesCurrentVersion keeps the same recovery detail
// available to humans, who do not pass --json.
func TestVersionConflictTextNamesCurrentVersion(t *testing.T) {
	srv := conflictServer(t)
	html := jsonTestEnv(t, srv)

	_, err := Execute([]string{"docs", "push", "doc_1", html, "--base-version", "ver_old"})
	if err == nil {
		t.Fatal("expected a version conflict")
	}
	if !strings.Contains(err.Error(), "ver_9") || !strings.Contains(err.Error(), "--base-version") {
		t.Fatalf("conflict text should name the current version and how to use it, got %q", err.Error())
	}
}

// TestJSONUsageErrorEnvelope covers a failure that never reaches the API.
func TestJSONUsageErrorEnvelope(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("AIDOCS_DISABLE_AUTO_UPDATE", "1")

	out, err := Execute([]string{"--json", "docs", "push", "doc_1"})
	if err == nil {
		t.Fatal("expected a usage error")
	}
	if code := ExitCode(err); code != 2 {
		t.Fatalf("exit code = %d, want 2 (unchanged)", code)
	}
	body := errorBodyOf(t, out)
	if body["code"] != "usage" {
		t.Fatalf("error.code = %v, want usage (output %q)", body["code"], out)
	}
	if msg, _ := body["message"].(string); msg == "" {
		t.Fatalf("error.message is empty (output %q)", out)
	}
}

// TestJSONQuietPrintsNothing documents the --quiet interplay: -q silences
// stdout, including the JSON value, and leaves the exit code alone.
func TestJSONQuietPrintsNothing(t *testing.T) {
	srv := conflictServer(t)
	html := jsonTestEnv(t, srv)

	out, err := Execute([]string{"--json", "--quiet", "docs", "push", "doc_1", html, "--base-version", "ver_old"})
	if err == nil {
		t.Fatal("expected a version conflict")
	}
	if code := ExitCode(err); code != 5 {
		t.Fatalf("exit code = %d, want 5", code)
	}
	if out != "" {
		t.Fatalf("--quiet should print nothing, got %q", out)
	}
}

// multiIDServer resolves cmt_1 and 404s cmt_2 when failSecond is set.
func multiIDServer(t *testing.T, failSecond bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/v1/documents/doc_1/comments/")
		if failSecond && id == "cmt_2" {
			w.WriteHeader(http.StatusNotFound)
			writeTestJSON(t, w, map[string]any{"error": map[string]any{"code": "not_found", "message": "not found"}})
			return
		}
		writeTestJSON(t, w, map[string]any{"id": id, "status": "resolved"})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// multiIDItems asserts the multi-id result is one JSON value listing every id.
func multiIDItems(t *testing.T, out string) []map[string]any {
	t.Helper()
	m := jsonObject(t, out)
	raw, ok := m["items"].([]any)
	if !ok {
		t.Fatalf("multi-id output has no items array: %q", out)
	}
	items := make([]map[string]any, 0, len(raw))
	for _, it := range raw {
		row, ok := it.(map[string]any)
		if !ok {
			t.Fatalf("multi-id item is not an object: %q", out)
		}
		items = append(items, row)
	}
	return items
}

func TestJSONMultiIDResolveIsOneValue(t *testing.T) {
	srv := multiIDServer(t, false)
	jsonTestEnv(t, srv)

	out, err := Execute([]string{"--json", "docs", "comments", "resolve", "doc_1", "cmt_1", "cmt_2"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	items := multiIDItems(t, out)
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2 (output %q)", len(items), out)
	}
	for i, want := range []string{"cmt_1", "cmt_2"} {
		if items[i]["id"] != want || items[i]["ok"] != true {
			t.Fatalf("item %d = %v, want %s applied (output %q)", i, items[i], want, out)
		}
	}
}

// TestJSONMultiIDReportsPartialFailure is the "which ids were applied?" case:
// one value naming the applied and the failed id, and a non-zero exit.
func TestJSONMultiIDReportsPartialFailure(t *testing.T) {
	srv := multiIDServer(t, true)
	jsonTestEnv(t, srv)

	out, err := Execute([]string{"--json", "docs", "comments", "resolve", "doc_1", "cmt_1", "cmt_2"})
	if err == nil {
		t.Fatal("expected the failed id to fail the command")
	}
	if code := ExitCode(err); code != 4 {
		t.Fatalf("exit code = %d, want 4 (the 404 that failed it)", code)
	}
	items := multiIDItems(t, out)
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2 (output %q)", len(items), out)
	}
	if items[0]["id"] != "cmt_1" || items[0]["ok"] != true {
		t.Fatalf("first id should be reported as applied, got %v (output %q)", items[0], out)
	}
	if items[1]["id"] != "cmt_2" || items[1]["ok"] != false {
		t.Fatalf("second id should be reported as failed, got %v (output %q)", items[1], out)
	}
	failure, ok := items[1]["error"].(map[string]any)
	if !ok || failure["code"] != "not_found" {
		t.Fatalf("failed id should carry why, got %v (output %q)", items[1]["error"], out)
	}
}

// jsonContractServer answers every route the broad --json table exercises.
func jsonContractServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case p == "/skills/aidocs/SKILL.md":
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			writeTestString(t, w, "---\nname: aidocs\ndescription: e2e skill\n---\n")
		case p == "/version.json":
			writeTestJSON(t, w, map[string]any{"version": Version, "commit": "", "install": "/install.sh"})
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case p == "/v1/me":
			writeTestJSON(t, w, map[string]any{"principal": map[string]any{"type": "user", "id": "usr_1"}, "user": map[string]any{"id": "usr_1", "email": "me@example.com"}})
		case p == "/v1/config":
			writeTestJSON(t, w, map[string]any{"deployment": "org", "org_name": "Acme", "everyone_label": "Acme"})
		case p == "/v1/documents" && r.Method == http.MethodPost:
			requireMultipart(t, r)
			writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_new", "default_grant": map[string]any{"grant_id": "gr_new", "principal": map[string]any{"type": "anyone"}, "role": "viewer"}})
		case p == "/v1/documents/doc_1/versions" && r.Method == http.MethodPost:
			requireMultipart(t, r)
			writeTestJSON(t, w, map[string]any{"id": "ver_2", "number": 2, "sha256": "abc"})
		case strings.HasSuffix(p, "/html"):
			w.Header().Set("Content-Type", "text/html")
			writeTestString(t, w, "<h1>ok</h1>")
		case strings.HasSuffix(p, "/access"):
			writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"effective_role": "viewer", "sources": []any{map[string]any{"grant_id": "gr_1"}}}}})
		case strings.HasSuffix(p, "/link"):
			writeTestJSON(t, w, map[string]any{"url": "https://aidocs.example/app/d/doc_1"})
		case p == "/v1/documents/doc_1":
			writeTestJSON(t, w, map[string]any{"id": "doc_1", "title": "Doc", "current_version_id": "ver_1", "parent_folder_id": "fld_1"})
		case strings.HasPrefix(p, "/v1/documents/doc_1/comments/"):
			writeTestJSON(t, w, map[string]any{"id": strings.TrimPrefix(p, "/v1/documents/doc_1/comments/"), "status": "resolved"})
		case p == "/v1/documents/doc_1/notifications" || p == "/v1/me/notifications":
			writeTestJSON(t, w, map[string]any{"enabled": true, "effective_enabled": true})
		case p == "/v1/documents/doc_1/labels":
			writeTestJSON(t, w, map[string]any{"items": []string{"api"}})
		case p == "/v1/documents/doc_1/grants":
			writeTestJSON(t, w, map[string]any{"id": "gr_1", "role": "viewer"})
		case p == "/v1/folders" && r.Method == http.MethodPost:
			writeTestJSON(t, w, map[string]any{"id": "fld_1", "title": "F"})
		default:
			writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"id": "x"}}})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestJSONOutputIsExactlyOneValue is the contract itself, swept across the
// command surface: with --json, stdout is always one JSON value and nothing
// else. Help and usage text is deliberately out of scope; it is not a result.
func TestJSONOutputIsExactlyOneValue(t *testing.T) {
	srv := jsonContractServer(t)
	html := jsonTestEnv(t, srv)
	pulled := filepath.Join(t.TempDir(), "pulled.html")

	cmds := [][]string{
		{"auth", "whoami"},
		{"config"},
		{"version"},
		{"guidelines"},
		{"update"},
		{"skills", "update"},
		{"notifications", "status"},
		{"docs", "list"},
		{"docs", "show", "doc_1"},
		{"docs", "create", html, "--title", "T"},
		{"docs", "update", "doc_1", "--title", "New"},
		{"docs", "labels", "list", "doc_1"},
		{"docs", "labels", "clear", "doc_1"},
		{"docs", "headings", "doc_1"},
		{"docs", "link", "doc_1"},
		{"docs", "notifications", "status", "doc_1"},
		{"docs", "versions", "list", "doc_1"},
		{"docs", "versions", "show", "doc_1", "ver_1"},
		{"docs", "versions", "html", "doc_1", "ver_1"},
		{"docs", "pull", "doc_1"},
		{"docs", "pull", "doc_1", "--out", pulled},
		{"docs", "push", "doc_1", html, "--base-version", "ver_1"},
		{"docs", "comments", "list", "doc_1"},
		{"docs", "comments", "update", "doc_1", "cmt_1", "--status", "resolved"},
		{"docs", "comments", "resolve", "doc_1", "cmt_1", "cmt_2"},
		{"docs", "comments", "delete", "doc_1", "cmt_1"},
		{"docs", "grants", "list", "doc_1"},
		{"docs", "grants", "add", "doc_1", "--to", "a@b.com", "--role", "viewer"},
		{"docs", "grants", "revoke", "doc_1", "gr_1"},
		{"docs", "move", "doc_1", "--root"},
		{"docs", "request-access", "doc_1"},
		{"docs", "delete", "doc_1"},
		{"folders", "list"},
		{"folders", "create", "--title", "F"},
		{"folders", "docs", "list", "fld_1"},
		{"sa", "list"},
		{"sa", "transfers", "list"},
		{"open", "doc_1"},
		{"context", "list"},
		{"context", "use", srv.URL},
		{"auth", "logout"},
	}
	for _, c := range cmds {
		t.Run(strings.Join(c, " "), func(t *testing.T) {
			out, err := Execute(append([]string{"--json"}, c...))
			if err != nil {
				t.Fatalf("%v (output %q)", err, out)
			}
			decodeSingleJSON(t, out)
		})
	}
}

// TestJSONAmbiguousFolderPathIsOneValue covers the one command that answers a
// non-2xx response as a success: an ambiguous folder path is a disambiguation
// prompt, so it keeps exit code 0 and the server's body, which is already
// exactly one JSON value. --quiet suppresses it like any other stdout output.
func TestJSONAmbiguousFolderPathIsOneValue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		writeTestJSON(t, w, map[string]any{
			"error":      map[string]any{"code": "ambiguous_path", "message": `Multiple folders named "A" found. Use --folder-id to specify.`},
			"candidates": []any{map[string]any{"id": "fld_1", "title": "A"}},
		})
	}))
	defer srv.Close()
	jsonTestEnv(t, srv)

	out, err := Execute([]string{"--json", "folders", "list", "--path", "/A"})
	if err != nil {
		t.Fatalf("ambiguous path should stay a successful prompt: %v", err)
	}
	if _, ok := jsonObject(t, out)["candidates"]; !ok {
		t.Fatalf("ambiguous output should keep the server's candidates: %q", out)
	}
	out, err = Execute([]string{"--json", "--quiet", "folders", "list", "--path", "/A"})
	if err != nil {
		t.Fatalf("quiet ambiguous path: %v", err)
	}
	if out != "" {
		t.Fatalf("--quiet should print nothing, got %q", out)
	}
}

// TestJSONEmptyResponseIsAnObject pins the 204 shape, which the MCP adapter
// already uses for empty results.
func TestJSONEmptyResponseIsAnObject(t *testing.T) {
	srv := jsonContractServer(t)
	jsonTestEnv(t, srv)

	out, err := Execute([]string{"--json", "docs", "comments", "delete", "doc_1", "cmt_1"})
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	m := jsonObject(t, out)
	if m["ok"] != true {
		t.Fatalf(`204 output = %q, want {"ok":true}`, out)
	}
}
