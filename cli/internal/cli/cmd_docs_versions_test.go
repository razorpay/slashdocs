package cli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateAndPushRecordBaseVersion(t *testing.T) {
	for _, output := range []string{"--quiet", "--json", ""} {
		t.Run(output, func(t *testing.T) {
			version := 1
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/documents":
					requireMultipart(t, r)
					writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_1"})
				case "/v1/documents/doc_new/versions":
					requireMultipart(t, r)
					if got := r.FormValue("base_version_id"); got != fmt.Sprintf("ver_%d", version) {
						w.WriteHeader(http.StatusConflict)
						writeTestJSON(t, w, map[string]any{"error": map[string]string{"code": "version_conflict"}})
						return
					}
					version++
					writeTestJSON(t, w, map[string]any{"id": fmt.Sprintf("ver_%d", version), "number": version})
				case "/v1/config":
					writeTestJSON(t, w, map[string]string{"deployment": "personal"})
				case "/version.json":
					writeTestJSON(t, w, map[string]string{"version": "dev"})
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			t.Setenv("SLASHDOCS_SERVER", srv.URL)
			t.Setenv("SLASHDOCS_TOKEN", "tok")
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			file := filepath.Join(t.TempDir(), "doc.html")
			writeTestFile(t, file, []byte("<p>test</p>"))
			for _, args := range [][]string{{"docs", "create", file}, {"docs", "push", "doc_new", file}, {"docs", "push", "doc_new", file}} {
				if output != "" {
					args = append([]string{output}, args...)
				}
				if _, err := Execute(args); err != nil {
					t.Fatalf("%v: %v", args, err)
				}
			}
			version++ // Another writer creates a version.
			if _, err := Execute([]string{"docs", "push", "doc_new", file}); err == nil || !strings.Contains(err.Error(), "version_conflict") {
				t.Fatalf("concurrent edit did not return a version conflict: %v", err)
			}
			cfg, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if got := cfg.Contexts[cfg.ActiveContext].Pulled["doc_new"]; got != "ver_3" {
				t.Fatalf("base version = %q, want ver_3", got)
			}
		})
	}
}
