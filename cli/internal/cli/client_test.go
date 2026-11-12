package cli

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
