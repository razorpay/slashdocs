package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type liveMessage struct {
	ID    int64                `json:"id"`
	Event repo.DocumentKVEvent `json:"event"`
}

func liveURL(ts *httptest.Server, docID, query string) string {
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/v1/documents/" + docID + "/live" + query
}

// dialWS opens a WebSocket, and returns the status of a refused handshake.
func dialWS(ctx context.Context, url string, headers http.Header) (*websocket.Conn, int, error) {
	//nolint:bodyclose // The connection owns the body of the handshake response.
	conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: headers})
	if resp == nil {
		return conn, 0, err
	}
	return conn, resp.StatusCode, err
}

func liveHeaders(p auth.Principal) http.Header {
	return http.Header{"X-Test-Principal": {principalHeader(p)}}
}

// dialLive opens the live connection of a document and reads up to the
// position of the document that ends its start, returning the messages
// before it.
func dialLive(ctx context.Context, t *testing.T, ts *httptest.Server, docID, query string, p auth.Principal) (*websocket.Conn, []liveMessage) {
	t.Helper()
	conn, _, err := dialWS(ctx, liveURL(ts, docID, query), liveHeaders(p))
	if err != nil {
		t.Fatalf("dial live: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	var start []liveMessage
	for {
		m := readLive(ctx, t, conn)
		if m.Event.Kind == repo.DocumentEventDocument && m.ID == 0 {
			return conn, start
		}
		start = append(start, m)
	}
}

func readLive(ctx context.Context, t *testing.T, conn *websocket.Conn) liveMessage {
	t.Helper()
	var m liveMessage
	if err := wsjson.Read(ctx, conn, &m); err != nil {
		t.Fatalf("read live: %v", err)
	}
	return m
}

func sendLive(ctx context.Context, t *testing.T, conn *websocket.Conn, report string) {
	t.Helper()
	if err := conn.Write(ctx, websocket.MessageText, []byte(report)); err != nil {
		t.Fatalf("send live: %v", err)
	}
}

func liveCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// A page cannot read the status of a refused handshake, so the server takes
// the connection and closes it with 4000 plus the status.
func TestDocumentLiveRefusesWithACloseCode(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	for _, tc := range []struct {
		name    string
		headers http.Header
		docID   string
		query   string
		want    websocket.StatusCode
	}{
		{"no credential", nil, e.doc.ID, "", 4401},
		{"no access", liveHeaders(fixtureStranger), e.doc.ID, "", 4403},
		{"missing document", liveHeaders(fixtureViewer), "doc_missing", "", 4404},
		{"bad session", liveHeaders(fixtureViewer), e.doc.ID, "?session=bad!", 4400},
		{"bad revision", liveHeaders(fixtureViewer), e.doc.ID, "?after_revision=-1", 4400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := liveCtx(t)
			conn, _, err := dialWS(ctx, liveURL(ts, tc.docID, tc.query), tc.headers)
			if err != nil {
				t.Fatalf("dial: %v", err)
			}
			defer func() { _ = conn.CloseNow() }()
			if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != tc.want {
				t.Fatalf("read = %v, want close %d", err, tc.want)
			}
		})
	}
}

// Another site cannot connect with the cookie of the viewer.
func TestDocumentLiveRefusesAnotherOrigin(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	headers := liveHeaders(fixtureViewer)
	headers.Set("Origin", "https://evil.example")
	if _, status, err := dialWS(liveCtx(t), liveURL(ts, e.doc.ID, ""), headers); err == nil || status != http.StatusForbidden {
		t.Fatalf("dial = %d %v, want 403", status, err)
	}
}

// The connection outlives the read timeout of the server.
func TestDocumentLiveOutlivesTheReadTimeout(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewUnstartedServer(e.h)
	ts.Config.ReadTimeout = 100 * time.Millisecond
	ts.Start()
	defer ts.Close()
	ctx := liveCtx(t)
	conn, _ := dialLive(ctx, t, ts, e.doc.ID, "", fixtureViewer)
	time.Sleep(300 * time.Millisecond)
	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/kv", `{"set":{"a":1}}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	}), http.StatusOK)
	if got := readLive(ctx, t, conn); got.Event.Revision == 0 || got.ID != got.Event.Revision {
		t.Fatalf("event = %#v, want the KV change", got)
	}
}

// One connection carries the events of the document, the presence and the
// cursors of the other viewers, and the reports of its own viewer.
func TestDocumentLiveCarriesEventsAndReports(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx := liveCtx(t)
	viewer, start := dialLive(ctx, t, ts, e.doc.ID, "?session=viewer-session", fixtureViewer)
	if len(start) != 0 {
		t.Fatalf("start = %#v, want no viewers yet", start)
	}
	editor, _ := dialLive(ctx, t, ts, e.doc.ID, "?session=editor-session", fixtureEditor)

	sendLive(ctx, t, editor, `{"type":"presence","version":"`+e.ver.ID+`","anchor":{"quote":"fixture","start_offset":0,"end_offset":7}}`)
	got := readLive(ctx, t, viewer)
	if data := presenceOf(t, liveEvent{event: got.Event}); got.Event.Kind != repo.DocumentEventPresence || got.ID == 0 ||
		data["session"] != "editor-session" || data["anchor"] == nil || got.Event.UpdatedBy.ID != fixtureEditor.ID {
		t.Fatalf("presence = %#v, want the editor's stored place", got)
	}

	// The server drops a report that is not valid, or one over the size limit
	// of the POST route, as that route refuses it. The connection stays.
	sendLive(ctx, t, editor, `{"type":"cursor","version":"live","points":[{"t":1,"x":1.5}]}`)
	sendLive(ctx, t, editor, `{"type":"cursor","version":"live","points":[{"t":1,"path":"`+strings.Repeat("0.", 4<<10)+`0","x":0.5,"y":0.5}]}`)
	sendLive(ctx, t, editor, `{"type":"cursor","version":"live","points":[{"t":2,"path":"0.1","x":0.5,"y":0.5}]}`)
	got = readLive(ctx, t, viewer)
	want := `{"session":"editor-session","version":"live","points":[{"t":2,"path":"0.1","x":0.5,"y":0.5}]}`
	if got.Event.Kind != repo.DocumentEventCursor || got.ID != 0 || string(got.Event.Data) != want {
		t.Fatalf("cursor = %#v %s, want %s without an id", got, got.Event.Data, want)
	}

	body := `{"version_id":"` + e.ver.ID + `","body":"live","anchor":{"quote":"fixture"}}`
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	}), http.StatusCreated)
	comments := readLive(ctx, t, viewer)
	if comments.Event.Kind != repo.DocumentEventComments || comments.ID != comments.Event.Revision {
		t.Fatalf("event = %#v, want a comments event with its revision as id", comments)
	}

	// A viewer who connects later sees the editor at once, and the stored
	// events after the revision that they name.
	late, start := dialLive(ctx, t, ts, e.doc.ID, "?after_revision="+strconv.FormatInt(comments.ID-1, 10), fixtureViewer)
	if len(start) != 2 || start[0].ID != comments.ID || start[1].Event.Kind != repo.DocumentEventPresence || start[1].ID != 0 {
		t.Fatalf("start = %#v, want the comments event, then the editor without an id", start)
	}
	_ = late.CloseNow()

	if err := editor.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	left := readLive(ctx, t, viewer)
	if data := presenceOf(t, liveEvent{event: left.Event}); data["session"] != "editor-session" || data["left"] != true {
		t.Fatalf("event = %#v, want the editor gone", left)
	}
}

// A report over the budget of its POST route is dropped: the two share one.
func TestDocumentLiveSharesTheBudgetOfPresence(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx := liveCtx(t)
	for range 60 {
		assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/presence", `{"session":"editor-other-tab"}`, map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureEditor),
		}), http.StatusNoContent)
	}
	viewer, _ := dialLive(ctx, t, ts, e.doc.ID, "", fixtureViewer)
	editor, _ := dialLive(ctx, t, ts, e.doc.ID, "?session=editor-session", fixtureEditor)
	sendLive(ctx, t, editor, `{"type":"presence","version":"`+e.ver.ID+`"}`)
	sendLive(ctx, t, editor, `{"type":"cursor","version":"live","points":[{"t":1,"path":"0","x":0,"y":0}]}`)
	// The editor's reports are taken in order, so the presence is done when
	// the cursor comes.
	for got := readLive(ctx, t, viewer); got.Event.Kind != repo.DocumentEventCursor; got = readLive(ctx, t, viewer) {
		if data := presenceOf(t, liveEvent{event: got.Event}); data["session"] == "editor-session" {
			t.Fatalf("presence over the budget = %#v", got)
		}
	}
	viewers, err := e.store.ListDocumentPresence(ctx, e.doc.ID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range viewers {
		if strings.Contains(string(v.Data), "editor-session") {
			t.Fatalf("stored presence over the budget: %s", v.Data)
		}
	}
}

func TestDocumentLiveClosesWhenAccessEnds(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx := liveCtx(t)
	grant, err := e.store.CreateGrant(ctx, "document", e.doc.ID, fixtureStranger, repo.RoleViewer, fixtureOwner)
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := dialLive(ctx, t, ts, e.doc.ID, "", fixtureStranger)
	assertStatus(t, do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+grant.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	}), http.StatusNoContent)
	for {
		var m liveMessage
		if err := wsjson.Read(ctx, conn, &m); err != nil {
			if got := websocket.CloseStatus(err); got != 4403 {
				t.Fatalf("close = %v (%d), want 4403", err, got)
			}
			return
		}
	}
}

func TestDocumentLiveClosesWhenTheServerStops(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx := liveCtx(t)
	conn, _ := dialLive(ctx, t, ts, e.doc.ID, "", fixtureViewer)
	e.srv.CloseStreams()
	var m liveMessage
	if err := wsjson.Read(ctx, conn, &m); websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Fatalf("read = %#v %v, want close 1001", m, err)
	}
}
