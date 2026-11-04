package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// pointCommentServer records the body of each comment POST and serves a list
// with one text comment and three point comments.
func pointCommentServer(t *testing.T) func() []map[string]any {
	t.Helper()
	var mu sync.Mutex
	var posted []map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/documents/doc_1/comments", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var in map[string]any
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				t.Errorf("decode comment POST: %v", err)
			}
			mu.Lock()
			posted = append(posted, in)
			mu.Unlock()
			writeTestJSON(t, w, map[string]any{"id": "cmt_new", "status": "open"})
			return
		}
		writeTestJSON(t, w, map[string]any{"items": []any{
			map[string]any{"id": "cmt_text", "status": "open", "selected_text": "x", "anchor": map[string]any{"quote": "x"}},
			map[string]any{"id": "cmt_label", "status": "open", "selected_text": "Q3 revenue", "anchor": map[string]any{"quote": "Q3 revenue", "point": map[string]any{"target": "chart", "label": "Revenue chart", "x": 0.42, "y": 0.18}}},
			map[string]any{"id": "cmt_target", "status": "open", "anchor": map[string]any{"point": map[string]any{"target": "chart", "x": 0, "y": 1}}},
			map[string]any{"id": "cmt_path", "status": "open", "anchor": map[string]any{"point": map[string]any{"path": "0.3", "x": 0, "y": 1}}},
			map[string]any{"id": "cmt_body", "status": "open", "anchor": map[string]any{"point": map[string]any{"x": -0.1, "y": 0.5, "page_x": 40, "page_y": 300, "viewport_w": 1280}}},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), posted...)
	}
}

func TestCommentsCreatePointSendsPointAnchor(t *testing.T) {
	posted := pointCommentServer(t)
	got, err := Execute([]string{"docs", "comments", "create", "doc_1", "--body", "label this", "--version", "ver_1", "--target", "chart", "--label", "Revenue chart", "--quote", "Q3 revenue", "--x", "0.42", "--y", "0.18"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "Added comment") {
		t.Fatalf("output = %q", got)
	}
	want := map[string]any{"quote": "Q3 revenue", "prefix": "", "suffix": "", "point": map[string]any{"target": "chart", "label": "Revenue chart", "x": 0.42, "y": 0.18}}
	if p := posted(); len(p) != 1 || !reflect.DeepEqual(p[0]["anchor"], want) {
		t.Fatalf("posted = %#v, want anchor %#v", p, want)
	}
}

func TestCommentsCreateRejectsAnIncompletePoint(t *testing.T) {
	posted := pointCommentServer(t)
	base := []string{"docs", "comments", "create", "doc_1", "--body", "hi", "--version", "ver_1"}
	for name, extra := range map[string][]string{
		"no anchor":      {},
		"target only":    {"--target", "chart"},
		"no target":      {"--x", "0.5", "--y", "0.5"},
		"label only":     {"--quote", "x", "--label", "Chart"},
		"y out of range": {"--target", "chart", "--x", "0.5", "--y", "1000.5"},
		"x out of range": {"--target", "chart", "--x", "-1001", "--y", "0.5"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Execute(append(append([]string{}, base...), extra...)); err == nil {
				t.Fatal("want an error")
			}
		})
	}
	if p := posted(); len(p) != 0 {
		t.Fatalf("invalid combinations reached the server: %#v", p)
	}
}

func TestCommentsCreateTextSendsTextAnchor(t *testing.T) {
	posted := pointCommentServer(t)
	if _, err := Execute([]string{"docs", "comments", "create", "doc_1", "--body", "hi", "--version", "ver_1", "--quote", "x"}); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"quote": "x", "prefix": "", "suffix": ""}
	if p := posted(); len(p) != 1 || !reflect.DeepEqual(p[0]["anchor"], want) {
		t.Fatalf("posted = %#v, want anchor %#v", p, want)
	}
}

func TestCommentsListNamesThePinnedElement(t *testing.T) {
	pointCommentServer(t)
	got, err := Execute([]string{"docs", "comments", "list", "doc_1"})
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(got), "\n")
	if len(lines) != 5 {
		t.Fatalf("output = %q, want five rows", got)
	}
	for i, want := range []string{"", "selected_text=Q3 revenue  pin=Revenue chart", "pin=chart", "pin=element", "pin=page"} {
		if want == "" && strings.Contains(lines[i], "pin=") {
			t.Errorf("text comment shows a pin: %q", lines[i])
		}
		if want != "" && !strings.HasSuffix(lines[i], want) {
			t.Errorf("row %d = %q, want it to end with %q", i, lines[i], want)
		}
	}

	raw, err := Execute([]string{"--json", "docs", "comments", "list", "doc_1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `"target"`) || strings.Contains(raw, "pin=") {
		t.Fatalf("--json output was reshaped: %q", raw)
	}
}
