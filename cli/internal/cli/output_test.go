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

// TestCompactRowShowsVersionCreatedAt locks in that version rows surface
// created_at so readers can tell whether a doc is fresh or stale.
func TestCompactRowShowsVersionCreatedAt(t *testing.T) {
	t.Parallel()
	row := map[string]any{
		"id":         "ver_1",
		"number":     2,
		"sha256":     "abc123",
		"created_at": "2026-10-11T09:30:00Z",
	}
	want := "id=ver_1  number=2  sha256=abc123  created_at=2026-10-11T09:30:00Z"
	if got := compactRow(row); got != want {
		t.Fatalf("compactRow()\n got: %q\nwant: %q", got, want)
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
