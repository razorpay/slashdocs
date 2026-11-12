package cli

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

var waitAlice = map[string]any{"type": "user", "id": "usr_alice", "name": "alice"}

func waitMsg(id string, at time.Time) map[string]any {
	return map[string]any{"id": id, "status": "open", "body": "says " + id, "author": waitAlice, "created_at": at.Format(time.RFC3339Nano)}
}

// waitServer serves the open threads and the decisions that the functions
// give at the time of each request, and answers a reply with cmt_mine.
func waitServer(t *testing.T, threads func() []any, decisions func() []any) {
	t.Helper()
	waitPoll = 10 * time.Millisecond
	t.Cleanup(func() { waitPoll = 10 * time.Second })
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/documents/doc_1/comments", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("status") != "open" {
			t.Errorf("comments query = %q, want status=open", r.URL.RawQuery)
		}
		writeTestJSON(t, w, map[string]any{"items": threads()})
	})
	mux.HandleFunc("GET /v1/documents/doc_1/approvals", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(t, w, map[string]any{"items": decisions()})
	})
	mux.HandleFunc("POST /v1/documents/doc_1/comments/cmt_1/replies", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(t, w, map[string]any{"id": "cmt_mine"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
}

func none() []any { return nil }

func wait(t *testing.T, args ...string) string {
	t.Helper()
	got, err := Execute(append([]string{"docs", "wait", "doc_1"}, args...))
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestWaitGivesNewMessagesThatTheCLIDidNotWriteOnce(t *testing.T) {
	var said time.Time
	waitServer(t, func() []any {
		if said.IsZero() {
			return nil
		}
		thread := waitMsg("cmt_1", said)
		// The CLI wrote this reply, also as the same user as the reviewer.
		thread["replies"] = []any{waitMsg("cmt_mine", said.Add(time.Second))}
		return []any{thread, waitMsg("cmt_old", said.Add(-time.Hour))}
	}, none)
	if _, err := Execute([]string{"docs", "comments", "reply", "doc_1", "cmt_1", "--body", "Done."}); err != nil {
		t.Fatal(err)
	}
	if got := wait(t, "--timeout", "20ms"); got != "No new feedback.\n" {
		t.Fatalf("first wait = %q", got)
	}

	// A reviewer writes after the start of the next wait.
	said = time.Now().Add(100 * time.Millisecond)
	if got := wait(t, "--settle", "0s", "--timeout", "2s"); got != "id=cmt_1  status=open  body=says cmt_1  author=alice\n  reply id=cmt_mine  status=open  body=says cmt_mine  author=alice\n" {
		t.Fatalf("second wait = %q", got)
	}
	// The next wait starts after the feedback that this one gave.
	if got := wait(t, "--json", "--timeout", "20ms"); got != "{\n  \"decisions\": [],\n  \"items\": []\n}\n" {
		t.Fatalf("third wait = %q", got)
	}
}

func TestWaitHoldsABatchThatIsNotSettled(t *testing.T) {
	waitServer(t, func() []any { return []any{waitMsg("cmt_typing", time.Now())} }, none)
	if got := wait(t, "--settle", "1h", "--timeout", "50ms"); got != "A review is in progress: run wait again.\n" {
		t.Fatalf("output = %q", got)
	}
}

func TestWaitReturnsADecisionAtOnce(t *testing.T) {
	start := time.Now()
	// The reviewer writes and decides after the start of wait.
	said := start.Add(time.Second)
	waitServer(t, func() []any {
		return []any{waitMsg("cmt_typing", said)}
	}, func() []any {
		return []any{
			map[string]any{"approver": waitAlice, "decision": "rejected", "note": "Not yet", "decided_at": said.Format(time.RFC3339Nano)},
			map[string]any{"approver": map[string]any{"type": "user", "id": "usr_bob"}, "decision": nil},
		}
	})
	got := wait(t, "--settle", "1h", "--timeout", "1h")
	if time.Since(start) > 5*time.Second {
		t.Fatalf("wait took %v", time.Since(start))
	}
	if want := "id=cmt_typing  status=open  body=says cmt_typing  author=alice\ndecision=rejected  note=Not yet  approver=alice\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if got := wait(t, "--timeout", "20ms"); got != "No new feedback.\n" {
		t.Fatalf("the next wait = %q, want no feedback again", got)
	}
}
