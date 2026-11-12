package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestTextLinkKeepsQuoteInFragment(t *testing.T) {
	quote := "A + B & 你好 # fragment"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/documents/doc_1/link" {
			http.NotFound(w, r)
			return
		}
		if r.URL.RawQuery != "version=ver_1" {
			t.Errorf("unexpected link request: %s", r.URL)
		}
		writeTestJSON(t, w, map[string]string{"url": "https://slashdocs.example/app/d/doc_1?version=ver_1"})
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	out, err := Execute([]string{"--json", "docs", "link", "doc_1", "--version", "ver_1", "--text", quote, "--prefix", "Second: "})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(result.URL)
	if err != nil {
		t.Fatal(err)
	}
	// Read the escaped hash as the browser's location.hash does.
	fragment, err := url.ParseQuery(u.EscapedFragment())
	if err != nil {
		t.Fatal(err)
	}
	if fragment.Get("text") != quote || fragment.Get("prefix") != "Second: " || u.Query().Get("version") != "ver_1" {
		t.Fatalf("incorrect text link: %s", result.URL)
	}
}
