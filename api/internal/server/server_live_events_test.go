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

	body := `{"session":"editor-session","version":"` + e.ver.ID + `","points":[{"t":5,"path":"0.2","x":0.25,"y":1,"z":2.5,"v":{"path":"0.1","x":-1.5,"y":0.5,"z":2.5},"m":"Look here 👀"},{"t":21,"e":"0.3","c":0,"hidden":true},{"t":22,"e":"0.3","c":1000000,"a":0}]}`
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/cursor", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	}), http.StatusNoContent)

	got := readLiveEvent(t, reader)
	if got.name != repo.DocumentEventCursor || got.id != "" || got.event.UpdatedBy.ID != fixtureEditor.ID {
		t.Fatalf("event = %#v, want a cursor event without an id from the editor", got)
	}
	want := `{"session":"editor-session","version":"` + e.ver.ID + `","points":[{"t":5,"path":"0.2","x":0.25,"y":1,"z":2.5,"v":{"path":"0.1","x":-1.5,"y":0.5,"z":2.5},"m":"Look here 👀"},{"t":21,"path":"","x":0,"y":0,"e":"0.3","c":0,"hidden":true},{"t":22,"path":"","x":0,"y":0,"e":"0.3","c":1000000,"a":0}]}`
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
		{"negative zoom", fixtureViewer, point(`{"t":1,"z":-1}`), http.StatusBadRequest},
		{"too much zoom", fixtureViewer, point(`{"t":1,"z":101}`), http.StatusBadRequest},
		{"view too far outside the element", fixtureViewer, point(`{"t":1,"v":{"path":"0","x":1001,"y":0}}`), http.StatusBadRequest},
		{"long message", fixtureViewer, point(`{"t":1,"m":"` + strings.Repeat("a", 101) + `"}`), http.StatusBadRequest},
		{"message with a control character", fixtureViewer, point(`{"t":1,"m":"hi\u0007"}`), http.StatusBadRequest},
		{"view with a bad path", fixtureViewer, point(`{"t":1,"v":{"path":"0..1","x":0,"y":0}}`), http.StatusBadRequest},
		{"edited block with a bad path", fixtureViewer, point(`{"t":1,"e":"0..1"}`), http.StatusBadRequest},
		{"caret before the block", fixtureViewer, point(`{"t":1,"e":"0","c":-1}`), http.StatusBadRequest},
		{"caret too far into the block", fixtureViewer, point(`{"t":1,"e":"0","c":1000001}`), http.StatusBadRequest},
		{"caret between characters", fixtureViewer, point(`{"t":1,"e":"0","c":1.5}`), http.StatusBadRequest},
		{"selection with no caret", fixtureViewer, point(`{"t":1,"e":"0","a":1}`), http.StatusBadRequest},
		{"selection from before the block", fixtureViewer, point(`{"t":1,"e":"0","c":1,"a":-1}`), http.StatusBadRequest},
		{"selection from too far into the block", fixtureViewer, point(`{"t":1,"e":"0","c":1,"a":1000001}`), http.StatusBadRequest},
		{"selection from between characters", fixtureViewer, point(`{"t":1,"e":"0","c":1,"a":1.5}`), http.StatusBadRequest},
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

// Every change to the approvers or their decisions tells open viewers, so
// that the owner sees a decision as soon as the approver makes it.
func TestApprovalChangesAnnounceApprovals(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	reader, _ := openLiveStream(ctx, t, ts, e.doc.ID, "", fixtureOwner)
	next := func(by auth.Principal) {
		t.Helper()
		got := readLiveEvent(t, reader)
		if got.name != repo.DocumentEventApprovals || got.event.UpdatedBy.ID != by.ID {
			t.Fatalf("event = %#v, want an approvals event by %s", got, by.ID)
		}
	}

	request := mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	next(fixtureOwner)
	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)
	next(fixtureViewer)
	assertStatus(t, do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvals/"+jsonField(t, rr.Body.Bytes(), "id"), "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	}), http.StatusNoContent)
	next(fixtureViewer)
	assertStatus(t, do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvers/"+request, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	}), http.StatusNoContent)
	next(fixtureOwner)
}

// A grant on a folder gives access to the documents below it. When that
// access goes, the streams of those documents end at once, and not at the
// next keep-alive.
func TestAccessThatGoesEndsTheStreamsBelowIt(t *testing.T) {
	type ids struct{ top, below, other, grant, doc string }
	for _, tc := range []struct {
		name    string
		request func(ids) (method, path, body string)
	}{
		{"the folder grant goes", func(i ids) (string, string, string) {
			return http.MethodDelete, "/v1/folders/" + i.top + "/grants/" + i.grant, ""
		}},
		{"the folder goes", func(i ids) (string, string, string) { return http.MethodDelete, "/v1/folders/" + i.top, "" }},
		{"the folder of the document moves", func(i ids) (string, string, string) {
			return http.MethodPatch, "/v1/folders/" + i.below, `{"parent_folder_id":null}`
		}},
		{"the document moves to another folder", func(i ids) (string, string, string) {
			return http.MethodPost, "/v1/folders/" + i.other + "/documents", `{"document_id":"` + i.doc + `"}`
		}},
		{"the document moves to the root", func(i ids) (string, string, string) {
			return http.MethodDelete, "/v1/folders/" + i.below + "/documents/" + i.doc, ""
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newTestEnv(t)
			ctx := context.Background()
			folder := func(title, parent string) string {
				t.Helper()
				f, err := e.store.CreateFolder(ctx, fixtureOwner, title, parent)
				if err != nil {
					t.Fatal(err)
				}
				return f.ID
			}
			i := ids{top: folder("Top", ""), other: folder("Other", ""), doc: e.doc.ID}
			i.below = folder("Below", i.top)
			if _, err := e.store.MoveDocumentToFolder(ctx, fixtureOwner, i.below, e.doc.ID); err != nil {
				t.Fatal(err)
			}
			grant, err := e.store.CreateGrant(ctx, "folder", i.top, fixtureStranger, repo.RoleViewer, fixtureOwner)
			if err != nil {
				t.Fatal(err)
			}
			i.grant = grant.ID
			ts := httptest.NewServer(e.h)
			defer ts.Close()
			streamCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			reader, _ := openLiveStream(streamCtx, t, ts, e.doc.ID, "", fixtureStranger)

			method, path, body := tc.request(i)
			rr := do(t, e.h, method, path, body, map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureOwner)})
			if rr.Code >= 300 {
				t.Fatalf("status = %d; body=%s", rr.Code, rr.Body)
			}
			for {
				if _, err := reader.ReadString('\n'); err != nil {
					if streamCtx.Err() != nil {
						t.Fatal("the stream did not end when the access went")
					}
					return
				}
			}
		})
	}
}
