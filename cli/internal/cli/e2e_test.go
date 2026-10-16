package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// e2eMux builds the mock slashdocs API used by the CLI end-to-end tests.
func e2eMux(t *testing.T) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/me", jsonH(t, map[string]any{"principal": map[string]any{"type": "user", "id": "usr_1"}, "user": map[string]any{"id": "usr_1", "email": "me@example.com", "name": "Me"}}))
	mux.HandleFunc("/v1/config", jsonH(t, map[string]any{"deployment": "org", "org_name": "Acme", "everyone_label": "Acme"}))
	mux.HandleFunc("/v1/documents", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "GET":
			if got := r.URL.Query().Get("q"); got != "" && got != `incident from:alice@example.com label:api,review in:"Product Specs"` {
				t.Fatalf("document search query = %q", got)
			}
			writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"id": "doc_1", "title": "Doc", "current_version_id": "ver_1"}}})
		case "POST":
			requireMultipart(t, r)
			writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_new", "default_grant": map[string]any{"grant_id": "gr_new", "principal": map[string]any{"type": "anyone"}, "role": "viewer"}})
		default:
			w.WriteHeader(405)
		}
	})
	mux.HandleFunc("/v1/documents/doc_1/labels", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "GET":
			writeTestJSON(t, w, map[string]any{"items": []string{"api", "review"}})
		case "PUT":
			var in struct {
				Labels []string `json:"labels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				t.Fatal(err)
			}
			writeTestJSON(t, w, map[string]any{"items": in.Labels})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/v1/documents/doc_1", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(t, w, map[string]any{"id": "doc_1", "title": "Doc", "current_version_id": "ver_1"})
	})
	mux.HandleFunc("/v1/documents/doc_1/versions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			requireMultipart(t, r)
			writeTestJSON(t, w, map[string]any{"id": "ver_2", "number": 2, "sha256": "abc"})
			return
		}
		writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"id": "ver_1", "number": 1}}})
	})
	mux.HandleFunc("/v1/documents/doc_1/versions/ver_1", jsonH(t, map[string]any{"id": "ver_1", "number": 1}))
	mux.HandleFunc("/v1/documents/doc_1/versions/ver_1/html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		writeTestString(t, w, "<h1>ok</h1>")
	})
	mux.HandleFunc("/v1/documents/doc_1/comments", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			if in["version_id"] != "ver_1" {
				t.Fatalf("comment create used wrong version payload: %#v", in)
			}
			writeTestJSON(t, w, map[string]any{"id": "cmt_new", "status": "open"})
			return
		}
		writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"id": "cmt_1", "body": "fix", "status": "open"}}})
	})
	mux.HandleFunc("/v1/documents/doc_1/comments/cmt_1/replies", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Fatalf("reply used wrong method: %s", r.Method)
		}
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in["body"] != "reply" {
			t.Fatalf("reply create used wrong payload: %#v", in)
		}
		writeTestJSON(t, w, map[string]any{"id": "cmt_reply", "status": "open"})
	})
	mux.HandleFunc("/v1/documents/doc_1/comments/cmt_1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		if r.Method == "PATCH" {
			var in map[string]any
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				t.Fatal(err)
			}
			_, hasBody := in["body"]
			_, hasStatus := in["status"]
			if hasBody == hasStatus {
				t.Fatalf("comment PATCH must contain exactly the supplied field: %#v", in)
			}
		}
		writeTestJSON(t, w, map[string]any{"id": "cmt_1", "status": "ok"})
	})
	mux.HandleFunc("/v1/documents/doc_1/access", jsonH(t, map[string]any{"items": []any{map[string]any{"effective_role": "viewer", "principal": map[string]any{"type": "user", "id": "usr_2"}}}}))
	mux.HandleFunc("/v1/documents/doc_1/grants", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Fatalf("doc grant collection used unexpected method: %s", r.Method)
		}
		writeTestJSON(t, w, map[string]any{"id": "gr_1"})
	})
	// Default sharing is the server's job now: it reports the applied grant
	// on the create response, and the CLI must never POST grants for a fresh
	// document. (The explicit `docs grants add` tests use doc_1.)
	mux.HandleFunc("/v1/documents/doc_new/grants", func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("create flow must not touch grants client-side: %s %s", r.Method, r.URL.Path)
	})
	mux.HandleFunc("/v1/documents/doc_1/grants/gr_1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		writeTestJSON(t, w, map[string]any{"id": "gr_1", "role": "editor"})
	})
	mux.HandleFunc("/v1/service-accounts", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			writeTestJSON(t, w, map[string]any{"id": "sa_1", "name": "bot"})
			return
		}
		writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"id": "sa_1", "name": "bot"}}})
	})
	mux.HandleFunc("/v1/service-accounts/sa_1", jsonH(t, map[string]any{"id": "sa_1", "name": "bot"}))
	mux.HandleFunc("/v1/service-accounts/sa_1/keys", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			writeTestJSON(t, w, map[string]any{"id": "sak_1", "token": "slashdocs_sa_x"}) //nolint:gosec // This fixed value is a mock response, not a credential.
			return
		}
		writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{"id": "sak_1", "name": "k"}}})
	})
	mux.HandleFunc("/v1/service-accounts/sa_1/keys/sak_1", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	mux.HandleFunc("/v1/service-accounts/sa_1/transfer", func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in["to_user_email"] != "new@example.com" {
			t.Fatalf("transfer used wrong payload: %#v", in)
		}
		writeTestJSON(t, w, map[string]any{"id": "xfer_1", "status": "pending"})
	})
	mux.HandleFunc("/v1/service-accounts/transfers", jsonH(t, map[string]any{"items": []any{map[string]any{"id": "xfer_1"}}}))
	mux.HandleFunc("/v1/service-accounts/transfers/xfer_1/accept", jsonH(t, map[string]any{"id": "xfer_1", "status": "accepted"}))
	mux.HandleFunc("/v1/service-accounts/transfers/xfer_1/decline", jsonH(t, map[string]any{"id": "xfer_1", "status": "declined"}))
	return mux
}

func TestCLICommandsE2E(t *testing.T) {
	srv := httptest.NewServer(e2eMux(t))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_NO_BROWSER", "1")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))
	out := filepath.Join(t.TempDir(), "out.html")
	cmds := [][]string{{"auth", "whoami"}, {"docs", "list"}, {"docs", "list", `incident from:alice@example.com label:api,review in:"Product Specs"`}, {"docs", "labels", "list", "doc_1"}, {"docs", "labels", "set", "doc_1", "API,review"}, {"docs", "labels", "clear", "doc_1"}, {"docs", "create", html}, {"docs", "show", "doc_1"}, {"docs", "update", "doc_1", "--title", "New"}, {"docs", "versions", "list", "doc_1"}, {"docs", "versions", "show", "doc_1", "ver_1"}, {"docs", "versions", "html", "doc_1", "ver_1"}, {"docs", "pull", "doc_1", "--out", out}, {"docs", "push", "doc_1", html}, {"docs", "comments", "list", "doc_1"}, {"docs", "comments", "list", "doc_1", "--status", "all"}, {"docs", "comments", "create", "doc_1", "--body", "hi", "--quote", "x", "--version", "ver_1"}, {"docs", "comments", "reply", "doc_1", "cmt_1", "--body", "reply"}, {"docs", "comments", "update", "doc_1", "cmt_1", "--status", "resolved"}, {"docs", "comments", "update", "doc_1", "cmt_1", "--body", "revised"}, {"docs", "comments", "delete", "doc_1", "cmt_1"}, {"docs", "comments", "resolve", "doc_1", "cmt_1"}, {"docs", "comments", "reopen", "doc_1", "cmt_1"}, {"docs", "grants", "list", "doc_1"}, {"docs", "grants", "add", "doc_1", "--principal", "user:a@b.com", "--role", "viewer"}, {"docs", "grants", "update", "doc_1", "gr_1", "--role", "editor"}, {"docs", "grants", "revoke", "doc_1", "gr_1"}, {"sa", "list"}, {"sa", "create", "bot"}, {"sa", "update", "sa_1", "--disable"}, {"sa", "key", "list", "sa_1"}, {"sa", "key", "create", "sa_1"}, {"sa", "key", "revoke", "sa_1", "sak_1"}, {"sa", "transfer", "sa_1", "--to", "new@example.com"}, {"sa", "transfers", "list"}, {"sa", "transfer", "accept", "xfer_1"}, {"sa", "transfer", "decline", "xfer_1"}, {"context", "list"}, {"context", "use", srv.URL}, {"skills", "update"}, {"open", "doc_1"}}
	for _, c := range cmds {
		t.Run(strings.Join(c, " "), func(t *testing.T) {
			if _, err := Execute(c); err != nil {
				t.Fatalf("%v", err)
			}
		})
	}
	if b := readTestFile(t, out); string(b) != "<h1>ok</h1>" {
		t.Fatalf("pull wrote %q", b)
	}
}

// TestCommandOutputsAreConversational locks in the action-indicative output
// of mutating commands so it can't silently regress to raw API rows. The
// default (non-JSON) output must tell the caller what just happened.
func TestCommandOutputsAreConversational(t *testing.T) {
	srv := httptest.NewServer(e2eMux(t))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_NO_BROWSER", "1")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))
	out := filepath.Join(t.TempDir(), "out.html")

	cases := []struct {
		args []string
		want []string
	}{
		{[]string{"auth", "whoami"}, []string{"me@example.com", "server=" + srv.URL}},
		{[]string{"docs", "create", html}, []string{"Created document", "doc_new", "Gave org-wide read-only access by default", "shared org-wide by default", "grants revoke doc_new gr_new"}},
		{[]string{"docs", "update", "doc_1", "--title", "New"}, []string{"Renamed document", "doc_1"}},
		{[]string{"docs", "labels", "set", "doc_1", "API,review"}, []string{"Set labels", "api, review"}},
		{[]string{"docs", "labels", "clear", "doc_1"}, []string{"Cleared labels", "doc_1"}},
		{[]string{"docs", "pull", "doc_1", "--out", out}, []string{"Pulled version", "doc_1"}},
		{[]string{"docs", "push", "doc_1", html}, []string{"Pushed version", "ver_2"}},
		{[]string{"docs", "comments", "create", "doc_1", "--body", "hi", "--quote", "x", "--version", "ver_1"}, []string{"Added comment"}},
		{[]string{"docs", "comments", "reply", "doc_1", "cmt_1", "--body", "reply"}, []string{"Created reply", "cmt_reply"}},
		{[]string{"docs", "comments", "delete", "doc_1", "cmt_1"}, []string{"Deleted comment", "cmt_1"}},
		{[]string{"docs", "comments", "resolve", "doc_1", "cmt_1"}, []string{"Resolved comment", "cmt_1"}},
		{[]string{"docs", "comments", "reopen", "doc_1", "cmt_1"}, []string{"Reopened comment", "cmt_1"}},
		{[]string{"docs", "grants", "add", "doc_1", "--to", "a@b.com", "--role", "viewer"}, []string{"Shared", "a@b.com", "viewer"}},
		{[]string{"docs", "grants", "add", "doc_1", "--everyone", "--role", "viewer"}, []string{"Shared", "viewer"}},
		{[]string{"docs", "grants", "revoke", "doc_1", "gr_1"}, []string{"Revoked grant", "gr_1"}},
		{[]string{"sa", "update", "sa_1", "--disable"}, []string{"Disabled service account", "sa_1"}},
		{[]string{"sa", "key", "create", "sa_1"}, []string{"Created key", "Copy this key"}},
		{[]string{"sa", "key", "revoke", "sa_1", "sak_1"}, []string{"Revoked key", "sak_1"}},
		{[]string{"sa", "transfer", "sa_1", "--to", "new@example.com"}, []string{"Requested transfer", "new@example.com"}},
		{[]string{"sa", "transfer", "accept", "xfer_1"}, []string{"Accepted transfer", "xfer_1"}},
		{[]string{"sa", "transfer", "decline", "xfer_1"}, []string{"Declined transfer", "xfer_1"}},
		{[]string{"open", "doc_1"}, []string{"doc_1"}},
		{[]string{"context", "use", srv.URL}, []string{"Switched to context"}},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			got, err := Execute(tc.args)
			if err != nil {
				t.Fatalf("%v", err)
			}
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Fatalf("output %q does not contain %q", got, w)
				}
			}
		})
	}
}

// TestJSONOutputStaysMachineReadable ensures --json keeps returning the raw
// API payload (not the conversational line) for mutating commands.
func TestJSONOutputStaysMachineReadable(t *testing.T) {
	srv := httptest.NewServer(e2eMux(t))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	got, err := Execute([]string{"--json", "docs", "update", "doc_1", "--title", "New"})
	if err != nil {
		t.Fatalf("%v", err)
	}
	if strings.Contains(got, "\u2713") || strings.Contains(got, "Renamed document") {
		t.Fatalf("--json output should be the raw payload, got %q", got)
	}
	var m map[string]any
	if json.Unmarshal([]byte(got), &m) != nil {
		t.Fatalf("--json output is not valid JSON: %q", got)
	}
}

// TestJSONIncludesDocumentURL locks in that --json carries the same canonical
// document URL the human output prints, so agents never have to construct one.
func TestJSONIncludesDocumentURLAndNudge(t *testing.T) {
	srv := httptest.NewServer(e2eMux(t))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_NO_BROWSER", "1")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))

	cases := []struct {
		args    []string
		wantURL string
	}{
		{[]string{"--json", "docs", "create", html}, srv.URL + "/app/d/doc_new"},
		{[]string{"--json", "docs", "push", "doc_1", html, "--base-version", "ver_1"}, srv.URL + "/app/d/doc_1"},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			got, err := Execute(tc.args)
			if err != nil {
				t.Fatalf("%v", err)
			}
			var m map[string]any
			if json.Unmarshal([]byte(got), &m) != nil {
				t.Fatalf("--json output is not valid JSON: %q", got)
			}
			if m["url"] != tc.wantURL {
				t.Fatalf("url = %v, want %v (output %q)", m["url"], tc.wantURL, got)
			}
			if strings.Join(tc.args, " ") == "--json docs create "+html {
				dg, ok := m["default_grant"].(map[string]any)
				if !ok || dg["grant_id"] != "gr_new" {
					t.Fatalf("create JSON should pass default_grant through, got %v (output %q)", m["default_grant"], got)
				}
				warning, _ := m["warning"].(string)
				if !strings.Contains(warning, "shared org-wide by default") || !strings.Contains(warning, "slashdocs docs grants revoke doc_new gr_new") {
					t.Fatalf("create JSON should carry the share warning with the real grant id, got %q (output %q)", warning, got)
				}
				if msg, ok := m["message"].(string); ok && strings.Contains(msg, "slashdocs docs grants add") {
					t.Fatalf("create JSON should not include nudge when auto-granted, got %q", got)
				}
			}
		})
	}
}

// TestCreateGrantsOrgWideViewerByDefault locks in the response-driven share
// rendering: the server applies its default grant and reports it on the
// create response; the CLI renders the notice with the real grant id and
// never POSTs grants itself during create (the default case enforces it).
func TestCreateGrantsOrgWideViewerByDefault(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/documents":
			requireMultipart(t, r)
			if v := r.FormValue("default_permission"); v != "" {
				t.Fatalf("create sent default_permission %q with no env override", v)
			}
			writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_new", "default_grant": map[string]any{"grant_id": "gr_srv", "principal": map[string]any{"type": "anyone"}, "role": "viewer"}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
			writeTestJSON(t, w, map[string]any{"deployment": "org", "org_name": "Acme", "everyone_label": "Acme"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))

	got, err := Execute([]string{"docs", "create", html})
	if err != nil {
		t.Fatalf("%v", err)
	}
	if !strings.Contains(got, "Gave org-wide read-only access by default") || strings.Contains(got, "Give org-wide read-only access?") {
		t.Fatalf("unexpected output %q", got)
	}
	if !strings.Contains(got, "shared org-wide by default") || !strings.Contains(got, "anyone at Acme can read it") {
		t.Fatalf("expected org-wide share notice, got %q", got)
	}
	if !strings.Contains(got, "slashdocs docs grants revoke doc_new gr_srv") {
		t.Fatalf("expected revoke recipe with the real grant id, got %q", got)
	}
}

// TestCreateQuietSendsDefaultPermission locks in that the CLI env override is
// forwarded as the default_permission form field even under --quiet, which
// suppresses all output — the granting itself is the server's job.
func TestCreateQuietSendsDefaultPermission(t *testing.T) {
	permission := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/documents" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		requireMultipart(t, r)
		permission = r.FormValue("default_permission")
		writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_new", "default_grant": map[string]any{"grant_id": "gr_srv", "principal": map[string]any{"type": "anyone"}, "role": "commenter"}})
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
	t.Setenv(defaultDocPermissionEnv, "commenter")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))

	got, err := Execute([]string{"--quiet", "docs", "create", html})
	if err != nil {
		t.Fatalf("%v", err)
	}
	if permission != "commenter" {
		t.Fatalf("default_permission form field = %q, want commenter", permission)
	}
	if got != "" {
		t.Fatalf("quiet create should print nothing, got %q", got)
	}
}

// TestCreatePrivateByDefaultOptsOut locks in the private override: the env is
// forwarded as default_permission=private, the server applies no grant, and
// the explicit preference suppresses the share nudge in both output modes.
func TestCreatePrivateByDefaultOptsOut(t *testing.T) {
	permission := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/documents" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		requireMultipart(t, r)
		permission = r.FormValue("default_permission")
		writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_new"})
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
	t.Setenv(defaultDocPermissionEnv, "private")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))

	got, err := Execute([]string{"docs", "create", html})
	if err != nil {
		t.Fatalf("%v", err)
	}
	if permission != "private" {
		t.Fatalf("default_permission form field = %q, want private", permission)
	}
	if strings.Contains(got, "Give org-wide read-only access?") || strings.Contains(got, "Gave org-wide") {
		t.Fatalf("private override should render neither grant line nor nudge, got %q", got)
	}

	got, err = Execute([]string{"--json", "docs", "create", html})
	if err != nil {
		t.Fatalf("%v", err)
	}
	var m map[string]any
	if json.Unmarshal([]byte(got), &m) != nil {
		t.Fatalf("--json output is not valid JSON: %q", got)
	}
	if _, ok := m["warning"]; ok {
		t.Fatalf("JSON create should not carry a share warning for a private create, got %q", got)
	}
	if _, ok := m["message"]; ok {
		t.Fatalf("JSON create should not nudge when the user chose private, got %q", got)
	}
}

// TestCreateWithoutDefaultGrantNudges keeps the transparency nudge for
// servers that default to private: no default_grant on the response and no
// explicit private preference means the CLI suggests sharing.
func TestCreateWithoutDefaultGrantNudges(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/documents":
			requireMultipart(t, r)
			writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_new"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/documents/doc_new/access":
			// Owner-only access, exactly as the live server reports for a
			// fresh private document: non-empty items whose sources carry no
			// grant_id. Counting raw items here (the old bug) suppresses the
			// nudge on every real server.
			writeTestJSON(t, w, map[string]any{"items": []any{map[string]any{
				"effective_role": "owner",
				"principal":      map[string]any{"type": "user", "id": "usr_1"},
				"sources": []any{map[string]any{
					"resource_type": "document", "resource_id": "doc_new", "role": "owner",
				}},
			}}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
			writeTestJSON(t, w, map[string]any{"deployment": "org", "org_name": "Acme", "everyone_label": "Acme"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))

	got, err := Execute([]string{"docs", "create", html})
	if err != nil {
		t.Fatalf("%v", err)
	}
	if !strings.Contains(got, "Give org-wide read-only access?") || !strings.Contains(got, "We are transparent here at Acme") {
		t.Fatalf("expected nudge for an ungranted create, got %q", got)
	}

	got, err = Execute([]string{"--json", "docs", "create", html})
	if err != nil {
		t.Fatalf("%v", err)
	}
	var m map[string]any
	if json.Unmarshal([]byte(got), &m) != nil {
		t.Fatalf("--json output is not valid JSON: %q", got)
	}
	msg, _ := m["message"].(string)
	if !strings.Contains(msg, "slashdocs docs grants add doc_new --everyone --role viewer") {
		t.Fatalf("JSON create should carry the nudge, got %q (output %q)", msg, got)
	}
}

// TestCreateInvalidDefaultPermissionEnv rejects a bad override with a command
// error before any request leaves the machine.
func TestCreateInvalidDefaultPermissionEnv(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("invalid override must not reach the server: %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
	t.Setenv(defaultDocPermissionEnv, "everyone")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))

	_, err := Execute([]string{"docs", "create", html})
	if err == nil || !strings.Contains(err.Error(), defaultDocPermissionEnv) || !strings.Contains(err.Error(), "everyone") {
		t.Fatalf("expected invalid-permission command error, got %v", err)
	}
}

// TestWhoamiServiceAccountParity locks in that whoami renders a service
// account's name (its bot address) and status, matching the detail shown for
// human users rather than collapsing to a bare type=service_account row.
func TestCreateWithoutIDDoesNotPrintBrokenURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/documents" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		requireMultipart(t, r)
		writeTestJSON(t, w, map[string]any{"current_version_id": "ver_new"})
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
	html := filepath.Join(t.TempDir(), "x.html")
	writeTestFile(t, html, []byte("<h1>x</h1>"))

	got, err := Execute([]string{"docs", "create", html})
	if err != nil {
		t.Fatalf("%v", err)
	}
	if strings.Contains(got, "%3Cnil%3E") || strings.Contains(got, "/app/d/") {
		t.Fatalf("create without id printed broken URL: %q", got)
	}
	if !strings.Contains(got, "Document URL unavailable") {
		t.Fatalf("create without id should explain missing URL, got %q", got)
	}
}

func TestWhoamiServiceAccountParity(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/me" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		writeTestJSON(t, w, map[string]any{
			"principal":       map[string]any{"type": "service_account", "id": "sa_1"},
			"service_account": map[string]any{"id": "sa_1", "name": "n8n-prod@brave.otter.bot", "disabled": false, "owner": map[string]any{"id": "usr_1", "email": "owner@example.com", "name": "Owner"}},
		})
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")

	got, err := Execute([]string{"auth", "whoami"})
	if err != nil {
		t.Fatalf("%v", err)
	}
	for _, w := range []string{"n8n-prod@brave.otter.bot", "sa_1", "server=" + srv.URL} {
		if !strings.Contains(got, w) {
			t.Fatalf("whoami output %q missing %q", got, w)
		}
	}
}

func TestLogoutRevokeCallsServer(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && r.URL.Path == "/v1/auth/cli/credentials/cred_1" {
			called = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfg := Config{ActiveContext: "example", Contexts: map[string]*Context{"example": {Server: srv.URL, Credential: map[string]any{"id": "cred_1", "token": "tok"}, Pulled: map[string]string{}}}}
	if err := saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute([]string{"auth", "logout"}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("expected server revoke call")
	}
}

func TestNormalizeServerUsesHTTPForLocalhost(t *testing.T) {
	cases := map[string]string{
		"localhost:8080":        "http://localhost:8080",
		"127.0.0.1:8080":        "http://127.0.0.1:8080",
		"slashdocs.example.com": "https://slashdocs.example.com",
		"http://localhost:8080": "http://localhost:8080",
	}
	for in, want := range cases {
		if got := normalizeServer(in); got != want {
			t.Fatalf("normalizeServer(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExitCodeMapping(t *testing.T) {
	cases := []struct{ status, want int }{{401, 3}, {403, 3}, {404, 4}, {409, 5}, {500, 1}}
	for _, tc := range cases {
		if got := ExitCode(&APIError{Status: tc.status, Message: "x"}); got != tc.want {
			t.Fatalf("status %d got %d want %d", tc.status, got, tc.want)
		}
	}
	if got := ExitCode(usageError{fmt.Errorf("unknown flag: --wat")}); got != 2 {
		t.Fatalf("usage error got %d", got)
	}
	_, err := Execute([]string{"wat"})
	if err == nil || !strings.Contains(err.Error(), `unknown command "wat"`) {
		t.Fatalf("expected unknown command error, got %v", err)
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("unknown command got %d", got)
	}
}

// TestNoServerConfiguredFailsWithGuidance locks in that a CLI with no config,
// flag, or environment never targets a baked-in default host: it fails and
// tells the user how to point it at a server.
func TestNoServerConfiguredFailsWithGuidance(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_SERVER", "")
	t.Setenv("SLASHDOCS_TOKEN", "")
	for _, args := range [][]string{{"auth", "login"}, {"docs", "list"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			_, err := Execute(args)
			if err == nil || !strings.Contains(err.Error(), "--server <url>") {
				t.Fatalf("expected no-server guidance, got %v", err)
			}
		})
	}
	if _, err := Execute([]string{"auth", "login"}); ExitCode(err) != 2 {
		t.Fatalf("login without server should be a usage error, got %v", err)
	}
}

func TestSACommandsCanBeDisabled(t *testing.T) {
	t.Setenv("SLASHDOCS_DISABLE_SA_COMMANDS", "1")
	_, err := Execute([]string{"sa", "list"})
	if err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("expected disabled err, got %v", err)
	}
}

func jsonH(t *testing.T, v any) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		writeTestJSON(t, w, v)
	}
}
func requireMultipart(t *testing.T, r *http.Request) {
	t.Helper()
	if err := r.ParseMultipartForm(32 << 20); err != nil { //nolint:gosec // The in-process fixture body is fixed and bounded by the test.
		t.Fatalf("multipart: %v", err)
	}
}
