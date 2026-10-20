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
// with one text comment and two point comments.
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
			map[string]any{"id": "cmt_text", "status": "open", "anchor": map[string]any{"quote": "x"}},
			map[string]any{"id": "cmt_pin", "status": "open", "anchor": map[string]any{"kind": "point", "point": map[string]any{"target": "t_mob", "x": 0.42, "y": 0.18}}},
			map[string]any{"id": "cmt_board", "status": "open", "anchor": map[string]any{"kind": "point", "point": map[string]any{"target": "", "x": 0, "y": 1}}},
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
	got, err := Execute([]string{"docs", "comments", "create", "doc_1", "--body", "move this", "--version", "ver_1", "--target", "t_mob", "--x", "0.42", "--y", "0.18"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "Added comment") {
		t.Fatalf("output = %q", got)
	}
	want := map[string]any{"kind": "point", "point": map[string]any{"target": "t_mob", "x": 0.42, "y": 0.18}}
	if p := posted(); len(p) != 1 || !reflect.DeepEqual(p[0]["anchor"], want) {
		t.Fatalf("posted = %#v, want anchor %#v", p, want)
	}
}

func TestCommentsCreatePointOnBoardSendsEmptyTarget(t *testing.T) {
	posted := pointCommentServer(t)
	if _, err := Execute([]string{"docs", "comments", "create", "doc_1", "--body", "hi", "--version", "ver_1", "--x", "0", "--y", "1"}); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"kind": "point", "point": map[string]any{"target": "", "x": 0.0, "y": 1.0}}
	if p := posted(); len(p) != 1 || !reflect.DeepEqual(p[0]["anchor"], want) {
		t.Fatalf("posted = %#v, want anchor %#v", p, want)
	}
}

func TestCommentsCreatePointFlagsAreExclusiveWithQuote(t *testing.T) {
	posted := pointCommentServer(t)
	base := []string{"docs", "comments", "create", "doc_1", "--body", "hi", "--version", "ver_1"}
	for name, extra := range map[string][]string{
		"quote and target": {"--quote", "x", "--target", "t_mob", "--x", "0.5", "--y", "0.5"},
		"quote and x":      {"--quote", "x", "--x", "0.5", "--y", "0.5"},
		"prefix and point": {"--prefix", "p", "--x", "0.5", "--y", "0.5"},
		"target only":      {"--target", "t_mob"},
		"x only":           {"--x", "0.5"},
		"y out of range":   {"--x", "0.5", "--y", "1.5"},
		"x negative":       {"--x", "-0.1", "--y", "0.5"},
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

func TestCommentsCreateTextStillNeedsQuote(t *testing.T) {
	posted := pointCommentServer(t)
	if _, err := Execute([]string{"docs", "comments", "create", "doc_1", "--body", "hi", "--version", "ver_1"}); err == nil {
		t.Fatal("want an error without --quote or a point")
	}
	if _, err := Execute([]string{"docs", "comments", "create", "doc_1", "--body", "hi", "--version", "ver_1", "--quote", "x"}); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"quote": "x", "prefix": "", "suffix": ""}
	if p := posted(); len(p) != 1 || !reflect.DeepEqual(p[0]["anchor"], want) {
		t.Fatalf("posted = %#v, want anchor %#v", p, want)
	}
}

func TestCommentsListShowsPoint(t *testing.T) {
	pointCommentServer(t)
	got, err := Execute([]string{"docs", "comments", "list", "doc_1"})
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(got), "\n")
	if len(lines) != 3 {
		t.Fatalf("output = %q, want three rows", got)
	}
	if strings.Contains(lines[0], "point=") {
		t.Errorf("text comment shows a point: %q", lines[0])
	}
	if !strings.HasSuffix(lines[1], "point=t_mob@0.42,0.18") {
		t.Errorf("point row = %q, want point=t_mob@0.42,0.18", lines[1])
	}
	if !strings.HasSuffix(lines[2], "point=board@0,1") {
		t.Errorf("board row = %q, want point=board@0,1", lines[2])
	}

	raw, err := Execute([]string{"--json", "docs", "comments", "list", "doc_1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `"target"`) || strings.Contains(raw, "point=") {
		t.Fatalf("--json output was reshaped: %q", raw)
	}
}
