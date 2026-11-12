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
	body, ok := jsonObject(t, out)["error"].(map[string]any)
	if !ok {
		t.Fatalf("stdout is not an error envelope: %q", out)
	}
	return body
}

// conflictServer answers every version create with the 409 version_conflict
// response of the server, details included.
func conflictServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

// jsonTestEnv points the CLI at srv as a logged-in context, with throwaway
// config and home folders, and returns an HTML file to publish.
func jsonTestEnv(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_NO_BROWSER", "1")
	t.Setenv("SLASHDOCS_NO_KEYCHAIN", "1")
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
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

// TestJSONErrorEnvelopeIsTheServerResponse is the recovery case of issue #102:
// a caller reads current_version_id from a 409, in the shape of the server.
func TestJSONErrorEnvelopeIsTheServerResponse(t *testing.T) {
	html := jsonTestEnv(t, conflictServer(t))

	out, err := Execute([]string{"--json", "docs", "push", "doc_1", html, "--base-version", "ver_old"})
	if code := ExitCode(err); code != 5 {
		t.Fatalf("exit code = %d, want 5 (err %v)", code, err)
	}
	body := errorBodyOf(t, out)
	details, _ := body["details"].(map[string]any)
	if body["code"] != "version_conflict" || body["message"] != "base_version_id is stale" || details["current_version_id"] != "ver_9" {
		t.Fatalf("error envelope = %v, want the server response", body)
	}
}

// TestVersionConflictTextNamesCurrentVersion gives the same detail to a person
// who does not pass --json.
func TestVersionConflictTextNamesCurrentVersion(t *testing.T) {
	html := jsonTestEnv(t, conflictServer(t))

	_, err := Execute([]string{"docs", "push", "doc_1", html, "--base-version", "ver_old"})
	if err == nil || !strings.Contains(err.Error(), "current_version_id=ver_9") {
		t.Fatalf("conflict text should name the current version, got %v", err)
	}
}

func TestJSONCLIErrorEnvelope(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	out, err := Execute([]string{"--json", "docs", "push", "doc_1"})
	if code := ExitCode(err); code != 2 {
		t.Fatalf("exit code = %d, want 2 (err %v)", code, err)
	}
	body := errorBodyOf(t, out)
	if msg, _ := body["message"].(string); body["code"] != "usage" || !strings.Contains(msg, "missing argument <file>") {
		t.Fatalf("error envelope = %v, want a usage error that names <file>", body)
	}
}

func TestJSONQuietPrintsNothing(t *testing.T) {
	html := jsonTestEnv(t, conflictServer(t))

	out, err := Execute([]string{"--json", "--quiet", "docs", "push", "doc_1", html, "--base-version", "ver_old"})
	if code := ExitCode(err); code != 5 || out != "" {
		t.Fatalf("exit code = %d, output %q, want 5 and no output", code, out)
	}
}

// multiIDServer resolves every comment, except cmt_2 when failSecond is set.
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

// TestJSONMultiIDReportsEveryID is the "which ids were applied?" case: one
// value with an item for each id, and the exit code of the failure.
func TestJSONMultiIDReportsEveryID(t *testing.T) {
	jsonTestEnv(t, multiIDServer(t, true))

	out, err := Execute([]string{"--json", "docs", "comments", "resolve", "doc_1", "cmt_1", "cmt_2", "cmt_3"})
	if code := ExitCode(err); code != 4 {
		t.Fatalf("exit code = %d, want 4 (err %v)", code, err)
	}
	items, _ := jsonObject(t, out)["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items = %v, want 3", items)
	}
	resolved, _ := items[2].(map[string]any)
	failed, _ := items[1].(map[string]any)
	failure, _ := failed["error"].(map[string]any)
	if resolved["status"] != "resolved" || failed["id"] != "cmt_2" || failure["code"] != "not_found" {
		t.Fatalf("items = %v, want cmt_3 resolved and cmt_2 not_found", items)
	}
}

func TestMultiIDTextReportsEveryID(t *testing.T) {
	jsonTestEnv(t, multiIDServer(t, true))

	out, err := Execute([]string{"docs", "comments", "resolve", "doc_1", "cmt_1", "cmt_2", "cmt_3"})
	if err == nil || !strings.Contains(err.Error(), "comment cmt_2") {
		t.Fatalf("err = %v, want the failure of cmt_2", err)
	}
	if !strings.Contains(out, "Resolved comment cmt_1.") || !strings.Contains(out, "Resolved comment cmt_3.") {
		t.Fatalf("output = %q, want cmt_1 and cmt_3 resolved", out)
	}
}

// jsonContractServer answers every route of the --json sweep.
func jsonContractServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case p == "/version.json":
			writeTestJSON(t, w, map[string]any{"version": Version})
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case p == "/v1/me":
			writeTestJSON(t, w, map[string]any{"principal": map[string]any{"type": "user", "id": "usr_1"}})
		case p == "/v1/config":
			writeTestJSON(t, w, map[string]any{"deployment": "org", "org_name": "Acme"})
		case p == "/v1/documents" && r.Method == http.MethodPost:
			writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_new"})
		case p == "/v1/documents/doc_1/versions" && r.Method == http.MethodPost:
			writeTestJSON(t, w, map[string]any{"id": "ver_2", "number": 2})
		case strings.HasSuffix(p, "/html"):
			w.Header().Set("Content-Type", "text/html")
			writeTestString(t, w, "<h1>ok</h1>")
		case strings.HasSuffix(p, "/access"):
			writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"sources": []any{map[string]any{"grant_id": "gr_1"}}}}})
		case p == "/v1/documents/doc_1":
			writeTestJSON(t, w, map[string]any{"id": "doc_1", "current_version_id": "ver_1", "parent_folder_id": "fld_1"})
		default:
			writeTestJSON(t, w, map[string]any{"id": "x", "items": []any{}})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestJSONOutputIsExactlyOneValue sweeps the commands: with --json, stdout is
// always one JSON value. Help text is not a result, so it is out of scope.
func TestJSONOutputIsExactlyOneValue(t *testing.T) {
	srv := jsonContractServer(t)
	html := jsonTestEnv(t, srv)
	pulled := filepath.Join(t.TempDir(), "pulled.html")

	for _, c := range [][]string{
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
		{"docs", "labels", "clear", "doc_1"},
		{"docs", "versions", "html", "doc_1", "ver_1"},
		{"docs", "pull", "doc_1"},
		{"docs", "pull", "doc_1", "--out", pulled},
		{"docs", "push", "doc_1", html, "--base-version", "ver_1"},
		{"docs", "comments", "resolve", "doc_1", "cmt_1", "cmt_2"},
		{"docs", "comments", "delete", "doc_1", "cmt_1"},
		{"docs", "grants", "revoke", "doc_1", "gr_1"},
		{"docs", "move", "doc_1", "--root"},
		{"docs", "delete", "doc_1"},
		{"folders", "list"},
		{"open", "doc_1"},
		{"context", "list"},
		{"context", "use", srv.URL},
		{"auth", "logout"},
	} {
		t.Run(strings.Join(c, " "), func(t *testing.T) {
			out, err := Execute(append([]string{"--json"}, c...))
			if err != nil {
				t.Fatalf("%v (output %q)", err, out)
			}
			decodeSingleJSON(t, out)
		})
	}
}

// TestJSONEmptyResponseIsOK pins the shape of a 204, which the MCP adapter
// also uses for an empty result.
func TestJSONEmptyResponseIsOK(t *testing.T) {
	jsonTestEnv(t, jsonContractServer(t))

	out, err := Execute([]string{"--json", "docs", "comments", "delete", "doc_1", "cmt_1"})
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if m := jsonObject(t, out); m["ok"] != true || len(m) != 1 {
		t.Fatalf(`204 output = %q, want {"ok": true}`, out)
	}
}
