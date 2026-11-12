package cli

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestCompactRowAnnotatesMentionsInStableDeduplicatedOrder(t *testing.T) {
	t.Parallel()
	row := map[string]any{
		"id":     "cmt_1",
		"status": "open",
		"body":   "Ping @Alice and @review-bot",
		"mentions": []any{
			map[string]any{"principal": map[string]any{"type": "user", "id": "usr_1", "name": "Alice", "email": "alice@example.com"}},
			map[string]any{"principal": map[string]any{"type": "user", "id": "usr_1", "name": "Renamed duplicate"}},
			map[string]any{"principal": map[string]any{"type": "service_account", "id": "sa_1", "name": "review-bot"}},
			map[string]any{"principal": map[string]any{"name": "missing identity"}},
		},
	}
	want := "id=cmt_1  status=open  body=Ping @Alice and @review-bot  mentions=@Alice,@review-bot"
	if got := compactRow(row); got != want {
		t.Fatalf("compactRow()\n got: %q\nwant: %q", got, want)
	}

	row["mentions"] = []any{}
	if got := compactRow(row); strings.Contains(got, "mentions=") {
		t.Fatalf("empty mention annotation rendered in %q", got)
	}
}

// TestCompactRowRendersEffectiveAccess locks in that an access listing row is
// actionable: the anyone grant shows a principal label and the grant id that
// `grants revoke` requires.
func TestCompactRowRendersEffectiveAccess(t *testing.T) {
	t.Parallel()
	anyoneRow := map[string]any{
		"effective_role": "viewer",
		"principal":      map[string]any{"type": "anyone"},
		"sources": []any{map[string]any{
			"resource_type": "document", "resource_id": "doc_1",
			"role": "viewer", "grant_id": "gr_1",
		}},
	}
	want := "effective_role=viewer  principal=anyone  grant_id=gr_1"
	if got := compactRow(anyoneRow); got != want {
		t.Fatalf("compactRow()\n got: %q\nwant: %q", got, want)
	}

	ownerRow := map[string]any{
		"effective_role": "owner",
		"principal":      map[string]any{"type": "user", "id": "usr_1"},
		"sources": []any{map[string]any{
			"resource_type": "document", "resource_id": "doc_1", "role": "owner",
		}},
	}
	if got := compactRow(ownerRow); strings.Contains(got, "grant_id=") {
		t.Fatalf("ownership source rendered a grant id: %q", got)
	}
}

func TestJSONRenderingLeavesMentionPayloadUnchanged(t *testing.T) {
	t.Parallel()
	payload := []byte(`{"items":[{"id":"cmt_1","body":"Ping @Alice","mentions":[{"principal":{"type":"user","id":"usr_1","name":"Alice"},"offset":5,"length":6}]}]}`)
	var out bytes.Buffer
	if err := render(&out, &globals{json: true}, payload); err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("JSON render changed payload\n got: %#v\nwant: %#v", got, want)
	}
}

func TestPushSaysWhenTheSavedVersionHoldsEditsOfOtherPeople(t *testing.T) {
	t.Parallel()
	const (
		updated = "Other people edited this document while you worked. Your file now has their edits too."
		pull    = "Other people edited this document while you worked, and your file does not have their edits. Run slashdocs docs pull doc_1 --out report.latest.html, and make your next changes in that file."
	)
	for _, tc := range []struct {
		name        string
		g           globals
		rebased     bool
		fileUpdated bool
		unchanged   bool
		want        string
	}{
		{"a push that the server merged", globals{}, true, true, false, updated},
		{"a merged push of a file that changed", globals{}, true, false, false, pull},
		{"a push with nothing after its base", globals{}, false, true, false, "✓ Your change is in the document: http://localhost:8080/app/d/doc_1\n"},
		{"JSON output says if the file has the saved version", globals{json: true}, true, true, false, `"file_updated": true`},
		{"JSON output of a file that changed", globals{json: true}, true, false, false, `"file_updated": false`},
		{"quiet output", globals{quiet: true}, true, true, false, ""},
		{"a file that is the document", globals{}, false, true, true, "Nothing changed.\n"},
		{"JSON output of a file that is the document", globals{json: true}, false, true, true, `"unchanged": true`},
	} {
		var out bytes.Buffer
		body := map[string]any{"id": "ver_2", "number": 2, "rebased": tc.rebased, "unchanged": tc.unchanged}
		if err := printPushedVersion(&out, &tc.g, "doc_1", "http://localhost:8080", body, tc.fileUpdated, "slashdocs docs pull doc_1 --out report.latest.html"); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		got := out.String()
		if !tc.rebased && (strings.Contains(got, "Other people") || strings.Contains(got, "file_updated")) || !strings.Contains(got, tc.want) || tc.unchanged && strings.Contains(got, "Your change") {
			t.Errorf("%s: output %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestHumanizeShowsTheRepliesOfAThread(t *testing.T) {
	t.Parallel()
	alice := map[string]any{"type": "user", "id": "usr_1", "name": "Alice"}
	list := map[string]any{"items": []any{map[string]any{
		"id": "cmt_1", "status": "open", "body": "Why three?", "author": alice,
		"replies": []any{map[string]any{"id": "cmt_2", "body": "Data says so.", "author": map[string]any{"type": "service_account", "id": "sa_1", "name": "writer-bot"}}},
	}}}
	want := "id=cmt_1  status=open  body=Why three?  author=Alice\n  reply id=cmt_2  body=Data says so.  author=writer-bot"
	if got := humanize("", list); got != want {
		t.Fatalf("humanize()\n got: %q\nwant: %q", got, want)
	}
}
