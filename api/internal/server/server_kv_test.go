package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

type fixedKVSubscriber struct {
	events     chan repo.DocumentKVEvent
	subscribed chan string
}

func (s *fixedKVSubscriber) Subscribe(_ context.Context, documentID string) (<-chan repo.DocumentKVEvent, func(), error) {
	select {
	case s.subscribed <- documentID:
	default:
	}
	return s.events, func() {}, nil
}

func (s *fixedKVSubscriber) Relay(context.Context, repo.DocumentKVEvent) error { return nil }

type failingBacklogRepository struct {
	repo.Repository
	calls int
}

func (r *failingBacklogRepository) ListDocumentKVEvents(context.Context, string, int64, int32) ([]repo.DocumentKVEvent, error) {
	r.calls++
	if r.calls > 1 {
		return nil, fmt.Errorf("forced backlog failure")
	}
	events := make([]repo.DocumentKVEvent, 100)
	for i := range events {
		events[i] = repo.DocumentKVEvent{DocumentID: "doc_backlog", Revision: int64(i + 1)}
	}
	return events, nil
}

func TestDocumentKVAccessAndImmediatePersistence(t *testing.T) {
	e := newTestEnv(t)
	patch := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/kv", `{
	  "set": { "count": 1, "name": "demo" },
	  "delete": ["old"]
	}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, patch, http.StatusOK)
	var patched struct {
		Revision  int64                   `json:"revision"`
		Changes   []repo.DocumentKVChange `json:"changes"`
		UpdatedBy *auth.Principal         `json:"updated_by"`
	}
	if err := json.Unmarshal(patch.Body.Bytes(), &patched); err != nil {
		t.Fatalf("bad patch JSON: %v", err)
	}
	if patched.Revision != 1 || len(patched.Changes) != 3 {
		t.Fatalf("patch result = revision %d changes %d, want revision 1 changes 3: %s", patched.Revision, len(patched.Changes), patch.Body.String())
	}
	if patched.UpdatedBy == nil || patched.UpdatedBy.ID != "editor_1" {
		t.Fatalf("updated_by = %#v, want editor_1", patched.UpdatedBy)
	}

	for _, principal := range []auth.Principal{fixtureViewer, fixtureCommenter, fixtureEditor, fixtureOwner} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/kv", "", map[string]string{
			"X-Test-Principal": principalHeader(principal),
		})
		assertStatus(t, rr, http.StatusOK)
		assertJSON(t, rr.Body.Bytes(), `{
		  "revision": 1,
		  "items": { "count": 1, "name": "demo" }
		}`)
	}

	viewerWrite := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/kv", `{"set":{"count":2}}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, viewerWrite, http.StatusForbidden)

	versions := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, versions, http.StatusOK)
	var listed struct {
		Items []repo.Version `json:"items"`
	}
	if err := json.Unmarshal(versions.Body.Bytes(), &listed); err != nil {
		t.Fatalf("bad versions JSON: %v", err)
	}
	if len(listed.Items) != 1 {
		t.Fatalf("versions after KV write = %d, want 1", len(listed.Items))
	}
}

func TestDocumentKVScopesKeysByDocument(t *testing.T) {
	e := newTestEnv(t)
	firstID, _ := e.createDocument("first", "<html></html>", fixtureOwner)
	secondID, _ := e.createDocument("second", "<html></html>", fixtureOwner)

	for docID, value := range map[string]string{firstID: "one", secondID: "two"} {
		rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+docID+"/kv", fmt.Sprintf(`{"set":{"sharedKey":%q}}`, value), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureOwner),
		})
		assertStatus(t, rr, http.StatusOK)
	}

	doc1 := do(t, e.h, http.MethodGet, "/v1/documents/"+firstID+"/kv", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, doc1, http.StatusOK)
	assertJSON(t, doc1.Body.Bytes(), `{"revision":1,"items":{"sharedKey":"one"}}`)

	doc2 := do(t, e.h, http.MethodGet, "/v1/documents/"+secondID+"/kv", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, doc2, http.StatusOK)
	assertJSON(t, doc2.Body.Bytes(), `{"revision":1,"items":{"sharedKey":"two"}}`)
}

func TestDocumentKVEventStreamReplaysStoredEvents(t *testing.T) {
	e := newTestEnv(t)
	patch := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/kv", `{"set":{"review.checked":true}}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, patch, http.StatusOK)

	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/documents/"+e.doc.ID+"/kv/events?after_revision=0", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Test-Principal", principalHeader(fixtureViewer))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			t.Errorf("close event response body: %v", err)
		}
	}()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want event stream", ct)
	}

	event := readDocumentKVSSEEvent(t, bufio.NewReader(resp.Body))
	if event.Revision != 1 || len(event.Changes) != 1 {
		t.Fatalf("event = revision %d changes %d, want revision 1 changes 1", event.Revision, len(event.Changes))
	}
	if event.DocumentID != e.doc.ID || event.Changes[0].Key != "review.checked" {
		t.Fatalf("event = %#v, want %s review.checked", event, e.doc.ID)
	}
}

func TestDocumentKVEventStreamReceivesLiveEvents(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/documents/"+e.doc.ID+"/kv/events?after_revision=0", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Test-Principal", principalHeader(fixtureViewer))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			t.Errorf("close event response body: %v", err)
		}
	}()
	reader := bufio.NewReader(resp.Body)
	readSSEComment(t, reader, ": connected")

	patchReq, err := http.NewRequest(http.MethodPatch, ts.URL+"/v1/documents/"+e.doc.ID+"/kv", strings.NewReader(`{"set":{"review.checked":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	patchReq.Header.Set("Content-Type", "application/json")
	patchReq.Header.Set("X-Test-Principal", principalHeader(fixtureEditor))
	patchResp, err := ts.Client().Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := patchResp.Body.Close(); err != nil {
			t.Errorf("close patch response body: %v", err)
		}
	}()
	if patchResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(patchResp.Body)
		t.Fatalf("patch status = %d, want 200: %s", patchResp.StatusCode, body)
	}

	event := readDocumentKVSSEEvent(t, reader)
	if event.Revision != 1 || len(event.Changes) != 1 || event.Changes[0].Key != "review.checked" {
		t.Fatalf("event = %#v, want live revision 1 review.checked", event)
	}
}

func TestDocumentKVEventStreamValidatesAfterRevision(t *testing.T) {
	e := newTestEnv(t)
	for _, value := range []string{"-1", "not-a-revision", "1.5"} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/kv/events?after_revision="+value, "", map[string]string{
			"X-Test-Principal": principalHeader(fixtureViewer),
		})
		assertStatus(t, rr, http.StatusBadRequest)
	}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/kv/events", "", map[string]string{
		"Last-Event-ID":    "not-a-revision",
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusBadRequest)
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/kv/events?after_revision=1", "", map[string]string{
		"Last-Event-ID":    "not-a-revision",
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestDocumentKVEventStreamResumesAfterRevision(t *testing.T) {
	e := newTestEnv(t)
	for _, value := range []string{"one", "two"} {
		patch := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/kv", fmt.Sprintf(`{"set":{"status":%q}}`, value), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureEditor),
		})
		assertStatus(t, patch, http.StatusOK)
	}

	ts := httptest.NewServer(e.h)
	t.Cleanup(ts.Close)
	for _, tc := range []struct {
		name, query, lastEventID string
	}{
		{name: "query parameter", query: "?after_revision=1"},
		{name: "Last-Event-ID header", lastEventID: "1"},
		{name: "newer Last-Event-ID wins", query: "?after_revision=0", lastEventID: "1"},
		{name: "newer query parameter wins", query: "?after_revision=1", lastEventID: "0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			t.Cleanup(cancel)
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/documents/"+e.doc.ID+"/kv/events"+tc.query, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("X-Test-Principal", principalHeader(fixtureViewer))
			if tc.lastEventID != "" {
				req.Header.Set("Last-Event-ID", tc.lastEventID)
			}
			resp, err := ts.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := resp.Body.Close(); err != nil {
					t.Errorf("close event response body: %v", err)
				}
			})
			if event := readDocumentKVSSEEvent(t, bufio.NewReader(resp.Body)); event.Revision != 2 {
				t.Fatalf("resumed event revision = %d, want 2", event.Revision)
			}
		})
	}
}

func TestDocumentKVEventStreamBackfillsGapBeforeLiveEvent(t *testing.T) {
	subscriber := &fixedKVSubscriber{
		events:     make(chan repo.DocumentKVEvent, 1),
		subscribed: make(chan string, 1),
	}
	e := newConfiguredTestEnv(t, server.Config{Environment: "test"}, server.WithDocumentKVEvents(subscriber))
	first, err := e.store.PatchDocumentKV(context.Background(), e.doc.ID, map[string]json.RawMessage{"status": json.RawMessage(`"one"`)}, nil, fixtureEditor)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 {
		t.Fatalf("first revision = %d, want 1", first.Revision)
	}

	ts := httptest.NewServer(e.h)
	t.Cleanup(ts.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/documents/"+e.doc.ID+"/kv/events?after_revision=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Test-Principal", principalHeader(fixtureViewer))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := resp.Body.Close(); err != nil {
			t.Errorf("close event response body: %v", err)
		}
	})
	reader := bufio.NewReader(resp.Body)
	readSSEComment(t, reader, ": connected")
	select {
	case documentID := <-subscriber.subscribed:
		if documentID != e.doc.ID {
			t.Fatalf("subscribed document = %q, want %q", documentID, e.doc.ID)
		}
	case <-time.After(time.Second):
		t.Fatal("handler did not subscribe to the document")
	}

	second, err := e.store.PatchDocumentKV(context.Background(), e.doc.ID, map[string]json.RawMessage{"status": json.RawMessage(`"two"`)}, nil, fixtureEditor)
	if err != nil {
		t.Fatal(err)
	}
	third, err := e.store.PatchDocumentKV(context.Background(), e.doc.ID, map[string]json.RawMessage{"status": json.RawMessage(`"three"`)}, nil, fixtureEditor)
	if err != nil {
		t.Fatal(err)
	}
	subscriber.events <- repo.DocumentKVEvent{DocumentID: e.doc.ID, Revision: third.Revision, Changes: third.Changes, UpdatedBy: third.UpdatedBy}

	if event := readDocumentKVSSEEvent(t, reader); event.Revision != second.Revision {
		t.Fatalf("first backfilled revision = %d, want %d", event.Revision, second.Revision)
	}
	if event := readDocumentKVSSEEvent(t, reader); event.Revision != third.Revision {
		t.Fatalf("second backfilled revision = %d, want %d", event.Revision, third.Revision)
	}
}

func TestDocumentKVEventStreamDoesNotAppendJSONAfterBacklogStarts(t *testing.T) {
	e := newTestEnv(t)
	repository := &failingBacklogRepository{Repository: e.store}
	subscriber := &fixedKVSubscriber{
		events:     make(chan repo.DocumentKVEvent),
		subscribed: make(chan string, 1),
	}
	h := server.New(server.Config{Environment: "test"},
		server.WithRepository(repository),
		server.WithAuthenticator(testPrincipalAuth{}),
		server.WithDocumentKVEvents(subscriber),
	).Handler()

	rr := do(t, h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/kv/events", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusOK)
	if repository.calls != 2 {
		t.Fatalf("backlog calls = %d, want 2", repository.calls)
	}
	if body := rr.Body.String(); strings.Contains(body, `"error"`) || strings.Contains(body, `"code":"internal"`) {
		t.Fatalf("committed event stream contains an appended JSON error: %s", body)
	}
}
