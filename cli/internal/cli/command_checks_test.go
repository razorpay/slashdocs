package cli

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// failOnRequest is a server for commands that must fail before they call it.
func failOnRequest(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestUsageErrorsFailBeforeTheAction covers the usage findings of issue #229:
// each command exits 2 and does not call the server.
func TestUsageErrorsFailBeforeTheAction(t *testing.T) {
	jsonTestEnv(t, failOnRequest(t))

	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"docs", "cretae"}, "Did you mean this?\n\tcreate"},
		{[]string{"auth", "logout", "extra"}, `unexpected argument "extra"`},
		{[]string{"auth", "login", "example.com", "extra"}, `unexpected argument "extra"`},
		{[]string{"auth", "whoami", "extra"}, `unexpected argument "extra"`},
		{[]string{"context", "list", "extra"}, `unexpected argument "extra"`},
		{[]string{"folders", "list", "extra"}, `unexpected argument "extra"`},
		{[]string{"docs", "list", "two", "words"}, `unexpected argument "words"`},
		{[]string{"docs", "create"}, "missing argument <file>\n\nUsage: slashdocs docs create <file> [flags]\nExamples:\n  slashdocs docs create report.html"},
		{[]string{"docs", "comments", "resolve", "doc_1"}, "missing argument <comment_id>..."},
		{[]string{"docs", "comments", "react", "doc_1", "cmt_1", "-1"}, "unknown shorthand flag: '1' in -1\n\nRun 'slashdocs docs comments react --help' for usage."},
		{[]string{"docs", "labels", "set", "doc_1"}, "missing argument <label>..."},
		{[]string{"docs", "comments", "reply", "doc_1", "cmt_1"}, "--body (or --body-file) is required"},
		{[]string{"docs", "move", "doc_1"}, "at least one of the flags in the group [folder-id root] is required"},
		{[]string{"docs", "grants", "update", "doc_1", "gr_1"}, `required flag(s) "role" not set`},
		{[]string{"folders", "move", "fld_1"}, "at least one of the flags in the group [parent root] is required"},
		{[]string{"folders", "grants", "update", "fld_1", "gr_1"}, `required flag(s) "role" not set`},
		{[]string{"folders", "create"}, "--title is required"},
		{[]string{"sa", "update", "sa_1", "--enable", "--disable"}, "[disable enable] were all set"},
		{[]string{"local", "status", "--port", "-1"}, "invalid --port -1"},
		{[]string{"local", "status", "--port", "65536"}, "invalid --port 65536"},
		{[]string{"context", "use", "https://"}, `invalid server "https://"`},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			_, err := Execute(tc.args)
			if code := ExitCode(err); code != 2 || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("exit code %d, err %v, want 2 and %q", code, err, tc.want)
			}
		})
	}
	if cfg, _ := loadConfig(); len(cfg.Contexts) != 1 || cfg.Contexts[cfg.ActiveContext] == nil {
		t.Fatalf("a rejected command changed the config: %+v", cfg)
	}
}

func TestCommandGroupPrintsHelp(t *testing.T) {
	jsonTestEnv(t, failOnRequest(t))

	out, err := Execute([]string{"docs"})
	if err != nil || !strings.Contains(out, "Available Commands:") {
		t.Fatalf("err %v, output %q, want the help of docs", err, out)
	}
}

func TestContextListRedactsTheToken(t *testing.T) {
	jsonTestEnv(t, failOnRequest(t))

	out, err := Execute([]string{"--json", "context", "list"})
	if err != nil || strings.Contains(out, `"tok"`) || !strings.Contains(out, "cred_1") {
		t.Fatalf("err %v, output %q, want the credential without its token", err, out)
	}
}

func TestContextListReportsACorruptConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := saveConfig(Config{}); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, configPath(), []byte("{"))

	if _, err := Execute([]string{"context", "list"}); err == nil || !strings.Contains(err.Error(), "is corrupt") {
		t.Fatalf("err = %v, want the corrupt config", err)
	}
}

// TestPullKeepsBaseVersionWhenWriteFails guards the data-loss case of issue
// #229: a push must not use a base version whose content was never saved.
func TestPullKeepsBaseVersionWhenWriteFails(t *testing.T) {
	jsonTestEnv(t, jsonContractServer(t))

	if _, err := Execute([]string{"docs", "pull", "doc_1", "--out", t.TempDir()}); err == nil {
		t.Fatal("pull to a folder should fail")
	}
	if _, cx, _ := currentContext(&globals{}); cx.Pulled["doc_1"] != "" {
		t.Fatalf("base version = %q, want none after a failed write", cx.Pulled["doc_1"])
	}
}

func TestAmbiguousFolderPathFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		writeTestJSON(t, w, map[string]any{
			"error":      map[string]any{"code": "ambiguous_path", "message": `Multiple folders named "A" found. Use --folder-id to specify.`},
			"candidates": []any{map[string]any{"id": "fld_1", "title": "A", "owner": map[string]any{"type": "user", "id": "usr_1"}}},
		})
	}))
	defer srv.Close()
	jsonTestEnv(t, srv)

	out, err := Execute([]string{"folders", "list", "--path", "/A"})
	if code := ExitCode(err); code != 5 || out != "" || !strings.Contains(err.Error(), "1. A (owner: usr_1)\n     --folder-id fld_1") {
		t.Fatalf("exit code %d, output %q, err %v, want 5 and the candidates in the error", code, out, err)
	}
	out, err = Execute([]string{"--json", "folders", "list", "--path", "/A"})
	if _, ok := jsonObject(t, out)["candidates"]; !ok || ExitCode(err) != 5 {
		t.Fatalf("output %q, err %v, want the server response with its candidates", out, err)
	}
	if out, _ := Execute([]string{"--quiet", "folders", "list", "--path", "/A"}); out != "" {
		t.Fatalf("--quiet output = %q, want none", out)
	}
}

func TestVersionHonorsOutputFlags(t *testing.T) {
	out, err := Execute([]string{"--json", "version"})
	if err != nil || jsonObject(t, out)["version"] != Version {
		t.Fatalf("err %v, output %q, want the version as JSON", err, out)
	}
	if out, _ := Execute([]string{"--quiet", "version"}); out != "" {
		t.Fatalf("--quiet output = %q, want none", out)
	}
}
