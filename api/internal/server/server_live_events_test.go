package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type liveEvent struct {
	name  string
	id    string
	event repo.DocumentKVEvent
}

// openLiveStream connects to the document event stream and reads up to the
// ": connected" marker, returning the events sent before it (the snapshot).
func openLiveStream(ctx context.Context, t *testing.T, ts *httptest.Server, docID, query string, p auth.Principal) (*bufio.Reader, []liveEvent) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/documents/"+docID+"/kv/events"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Test-Principal", principalHeader(p))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stream status = %d, want 200", resp.StatusCode)
	}
	reader := bufio.NewReader(resp.Body)
	var snapshot []liveEvent
	for {
		lines := readSSEBlock(t, reader)
		if len(lines) == 1 && lines[0] == ": connected" {
			return reader, snapshot
		}
		snapshot = append(snapshot, parseLiveEvent(t, lines))
	}
}

func parseLiveEvent(t *testing.T, lines []string) liveEvent {
	t.Helper()
	var out liveEvent
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "event: "):
			out.name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "id: "):
			out.id = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "data: "):
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &out.event); err != nil {
				t.Fatalf("bad SSE data %q: %v", line, err)
			}
		}
	}
	return out
}

func readLiveEvent(t *testing.T, r *bufio.Reader) liveEvent {
	t.Helper()
	for {
		lines := readSSEBlock(t, r)
		if len(lines) > 0 && !strings.HasPrefix(lines[0], ":") {
			return parseLiveEvent(t, lines)
		}
	}
}

func presenceOf(t *testing.T, e liveEvent) map[string]any {
	t.Helper()
	var data map[string]any
	if err := json.Unmarshal(e.event.Data, &data); err != nil {
		t.Fatalf("presence data %s: %v", e.event.Data, err)
	}
	return data
}

func TestDocumentLiveStreamStartsAtLiveEdgeAndAnnouncesComments(t *testing.T) {
	e := newTestEnv(t)
	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/kv", `{"set":{"a":1}}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	}), http.StatusOK)

	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	reader, snapshot := openLiveStream(ctx, t, ts, e.doc.ID, "", fixtureViewer)
	if len(snapshot) != 0 {
		t.Fatalf("snapshot = %#v, want no replayed events", snapshot)
	}

	body := `{"version_id":"` + e.ver.ID + `","body":"live","anchor":{"quote":"fixture"}}`
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	}), http.StatusCreated)

	got := readLiveEvent(t, reader)
	if got.name != repo.DocumentEventComments || got.id != "2" || got.event.UpdatedBy.ID != fixtureCommenter.ID {
		t.Fatalf("event = %#v, want comments event at revision 2 by the commenter", got)
	}
}

func TestDocumentPresenceSnapshotLiveUpdatesAndLeave(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	post := func(p auth.Principal, body string) *httptest.ResponseRecorder {
		return do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/presence", body, map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(p),
		})
	}
	assertStatus(t, post(fixtureEditor, `{"session":"editor-session","version":"`+e.ver.ID+`"}`), http.StatusNoContent)

	reader, snapshot := openLiveStream(ctx, t, ts, e.doc.ID, "?session=viewer-session", fixtureViewer)
	if len(snapshot) != 1 || snapshot[0].name != repo.DocumentEventPresence || snapshot[0].id != "" {
		t.Fatalf("snapshot = %#v, want one presence event without an id", snapshot)
	}
	if data := presenceOf(t, snapshot[0]); data["session"] != "editor-session" || data["version"] != e.ver.ID || data["anchor"] != nil {
		t.Fatalf("snapshot presence = %v", data)
	}

	anchor := `{"quote":"fixture","prefix":"","suffix":"","start_offset":0,"end_offset":7}`
	assertStatus(t, post(fixtureEditor, `{"session":"editor-session","version":"`+e.ver.ID+`","anchor":`+anchor+`}`), http.StatusNoContent)
	if data := presenceOf(t, readLiveEvent(t, reader)); data["anchor"] == nil {
		t.Fatalf("live presence = %v, want the moved position", data)
	}

	editorCtx, editorLeave := context.WithCancel(ctx)
	openLiveStream(editorCtx, t, ts, e.doc.ID, "?session=editor-tab-2", fixtureEditor)
	editorLeave()
	left := readLiveEvent(t, reader)
	if data := presenceOf(t, left); data["session"] != "editor-tab-2" || data["left"] != true || left.event.UpdatedBy.ID != fixtureEditor.ID {
		t.Fatalf("leave event = %#v %v", left, data)
	}
}

func TestDocumentPresenceRejectsInvalidInput(t *testing.T) {
	e := newTestEnv(t)
	for _, tc := range []struct {
		name string
		p    auth.Principal
		body string
		want int
	}{
		{"stranger", fixtureStranger, `{"session":"stranger-session"}`, http.StatusForbidden},
		{"short session", fixtureViewer, `{"session":"short"}`, http.StatusBadRequest},
		{"negative offset", fixtureViewer, `{"session":"viewer-session","anchor":{"quote":"x","start_offset":-1}}`, http.StatusBadRequest},
		{"long quote", fixtureViewer, `{"session":"viewer-session","anchor":{"quote":"` + strings.Repeat("x", 600) + `"}}`, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/presence", tc.body, map[string]string{
				"Content-Type":     "application/json",
				"X-Test-Principal": principalHeader(tc.p),
			})
			assertStatus(t, rr, tc.want)
		})
	}
	stream := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/kv/events?session=bad!", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, stream, http.StatusBadRequest)
}

func TestDocumentCursorRelaysToOpenStreams(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	reader, _ := openLiveStream(ctx, t, ts, e.doc.ID, "?session=viewer-session", fixtureViewer)

	body := `{"session":"editor-session","version":"` + e.ver.ID + `","points":[{"t":5,"path":"0.2","x":0.25,"y":1},{"t":21,"hidden":true}]}`
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/cursor", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	}), http.StatusNoContent)

	got := readLiveEvent(t, reader)
	if got.name != repo.DocumentEventCursor || got.id != "" || got.event.UpdatedBy.ID != fixtureEditor.ID {
		t.Fatalf("event = %#v, want a cursor event without an id from the editor", got)
	}
	want := `{"session":"editor-session","version":"` + e.ver.ID + `","points":[{"t":5,"path":"0.2","x":0.25,"y":1},{"t":21,"path":"","x":0,"y":0,"hidden":true}]}`
	if string(got.event.Data) != want {
		t.Fatalf("cursor data = %s, want %s", got.event.Data, want)
	}
}

func TestDocumentCursorRejectsInvalidInput(t *testing.T) {
	e := newTestEnv(t)
	point := func(p string) string { return `{"session":"viewer-session","points":[` + p + `]}` }
	for _, tc := range []struct {
		name string
		p    auth.Principal
		body string
		want int
	}{
		{"stranger", fixtureStranger, point(`{"t":1}`), http.StatusForbidden},
		{"no points", fixtureViewer, point(``), http.StatusBadRequest},
		{"too many points", fixtureViewer, point(strings.Repeat(`{"t":1},`, 16) + `{"t":1}`), http.StatusBadRequest},
		{"outside the element", fixtureViewer, point(`{"t":1,"x":1.5}`), http.StatusBadRequest},
		{"bad path", fixtureViewer, point(`{"t":1,"path":"0..1"}`), http.StatusBadRequest},
		{"deep path", fixtureViewer, point(`{"t":1,"path":"0` + strings.Repeat(".0", 64) + `"}`), http.StatusBadRequest},
		{"negative time", fixtureViewer, point(`{"t":-1}`), http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/cursor", tc.body, map[string]string{
				"Content-Type":     "application/json",
				"X-Test-Principal": principalHeader(tc.p),
			})
			assertStatus(t, rr, tc.want)
		})
	}
}
