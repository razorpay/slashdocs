package cli

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestClientFollowsAndSavesPermanentServerMove(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_NO_KEYCHAIN", "1")
	t.Setenv("SLASHDOCS_SERVER", "")
	t.Setenv("SLASHDOCS_TOKEN", "")
	moved := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") != "Bearer tok" || r.Method != http.MethodPost || string(body) != `{"a":1}` {
			http.Error(w, "lost the request on redirect", http.StatusUnauthorized)
			return
		}
		writeTestString(t, w, `{}`)
	}))
	t.Cleanup(moved.Close)
	// Another host name, so Go removes the credentials on the redirect.
	movedURL := strings.Replace(moved.URL, "127.0.0.1", "localhost", 1)
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, movedURL+r.URL.RequestURI(), http.StatusPermanentRedirect) //nolint:gosec // G710: test server.
	}))
	t.Cleanup(old.Close)
	oldName, movedName := ctxName(old.URL), ctxName(movedURL)
	if err := saveConfig(Config{ActiveContext: oldName, Contexts: map[string]*Context{
		oldName: {Server: old.URL, Credential: map[string]any{"token": "tok"}, Pulled: map[string]string{"doc_1": "ver_1"}},
	}}); err != nil {
		t.Fatal(err)
	}

	c, err := client(&globals{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.doJSON(http.MethodPost, "/v1/things", map[string]int{"a": 1}); err != nil {
		t.Fatalf("request through the move failed: %v", err)
	}

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cx := cfg.Contexts[movedName]
	if cfg.ActiveContext != movedName || cfg.Contexts[oldName] != nil || cx == nil || cx.Server != movedURL || cx.Pulled["doc_1"] != "ver_1" {
		t.Fatalf("config after move = %+v", cfg)
	}
	if got := credentialToken(movedName, cx.Credential); got != "tok" {
		t.Fatalf("moved token = %q", got)
	}
}

func TestClientKeepsServerFromEnvironmentOnMove(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	moved := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeTestString(t, w, `{}`) }))
	t.Cleanup(moved.Close)
	old := httptest.NewServer(http.RedirectHandler(moved.URL+"/v1/me", http.StatusPermanentRedirect))
	t.Cleanup(old.Close)
	t.Setenv("SLASHDOCS_SERVER", old.URL)

	c, err := client(&globals{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.do(http.MethodGet, "/v1/me", nil, ""); err != nil {
		t.Fatal(err)
	}
	if cfg, _ := loadConfig(); len(cfg.Contexts) != 0 || c.Base != old.URL {
		t.Fatalf("a server set by the environment must not be saved: base=%s config=%+v", c.Base, cfg)
	}
}

func TestCLILoginURLUsesPortOnlyWhenAdvertised(t *testing.T) {
	const addr = "127.0.0.1:43111"
	withPort := cliLoginURL("https://docs.example", "st", "ch", addr, true)
	if !strings.Contains(withPort, "cli_port=43111") || strings.Contains(withPort, "cli_redirect") ||
		strings.Contains(strings.TrimPrefix(withPort, "https://docs.example"), "http") {
		t.Fatalf("port login URL = %s", withPort)
	}
	legacy := cliLoginURL("https://docs.example", "st", "ch", addr, false)
	if !strings.Contains(legacy, "cli_redirect=http%3A%2F%2F127.0.0.1%3A43111%2Fcallback") || strings.Contains(legacy, "cli_port") {
		t.Fatalf("legacy login URL = %s", legacy)
	}
}

func TestClientAcceptsCLIPortOnlyWhenDiscoveryListsIt(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		want   bool
	}{
		"listed":       {http.StatusOK, `{"auth":{"modes":["web","cli"],"cli_params":["cli_redirect","cli_port"]}}`, true},
		"not listed":   {http.StatusOK, `{"auth":{"modes":["web","cli"]}}`, false},
		"no discovery": {http.StatusNotFound, `not found`, false},
		"not json":     {http.StatusOK, `<html></html>`, false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var hits atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/.well-known/slashdocs.json" {
					t.Errorf("unexpected request to %s", r.URL.Path)
				}
				hits.Add(1)
				w.WriteHeader(tc.status)
				writeTestString(t, w, tc.body)
			}))
			t.Cleanup(srv.Close)
			c := &Client{Base: srv.URL, HTTP: apiHTTPClient}
			if a, b := c.acceptsCLIPort(), c.acceptsCLIPort(); a != tc.want || b != tc.want {
				t.Fatalf("acceptsCLIPort = %v, %v; want %v", a, b, tc.want)
			}
			if n := hits.Load(); n != 1 {
				t.Fatalf("discovery hits = %d, want 1", n)
			}
		})
	}
}
