package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// statusFilterFixture builds three threads on one document:
//
//	orphaned: open, written on v1 whose text is gone from v2 (current)
//	attached: open, written on v2, text present
//	resolved: resolved, written on v2, with one reply that is still open
type statusFilterFixture struct {
	e                                  *testEnv
	orphanedID, attachedID, resolvedID string
	replyID                            string
}

func newStatusFilterFixture(t *testing.T) statusFilterFixture {
	t.Helper()
	e := newTestEnv(t)
	ctx := context.Background()
	v2, err := e.store.CreateVersion(ctx, e.doc.ID, e.ver.ID, "drop the old text", []byte("<html><body>kept text</body></html>"), fixtureOwner)
	if err != nil {
		t.Fatalf("create version: %v", err)
	}
	attached, err := e.store.CreateComment(ctx, e.doc.ID, v2.ID, "attached", repo.Anchor{Quote: "kept"}, fixtureCommenter, nil)
	if err != nil {
		t.Fatalf("create attached comment: %v", err)
	}
	resolved, err := e.store.CreateComment(ctx, e.doc.ID, v2.ID, "resolved", repo.Anchor{Quote: "text"}, fixtureCommenter, nil)
	if err != nil {
		t.Fatalf("create resolved comment: %v", err)
	}
	reply, err := e.store.CreateCommentReply(ctx, e.doc.ID, resolved.ID, "still talking", fixtureCommenter, nil)
	if err != nil {
		t.Fatalf("create reply: %v", err)
	}
	if _, err := e.store.UpdateComment(ctx, resolved.ID, repo.CommentUpdate{Status: "resolved"}); err != nil {
		t.Fatalf("resolve comment: %v", err)
	}
	return statusFilterFixture{e: e, orphanedID: e.cmt.ID, attachedID: attached.ID, resolvedID: resolved.ID, replyID: reply.ID}
}

type listedThread struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Replies []struct {
		ID string `json:"id"`
	} `json:"replies"`
}

// list returns the thread ids for ?status=<status> in response order.
func (f statusFilterFixture) list(t *testing.T, status string, want int) []listedThread {
	t.Helper()
	path := "/v1/documents/" + f.e.doc.ID + "/comments"
	if status != "" {
		path += "?status=" + status
	}
	rr := do(t, f.e.h, http.MethodGet, path, "", map[string]string{"X-Test-Principal": principalHeader(fixtureCommenter)})
	assertStatus(t, rr, want)
	if want != http.StatusOK {
		return nil
	}
	var out struct {
		Items []listedThread `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list: %v; body=%s", err, rr.Body.String())
	}
	return out.Items
}

func threadIDs(items []listedThread) map[string]bool {
	ids := map[string]bool{}
	for _, it := range items {
		ids[it.ID] = true
	}
	return ids
}

func TestListCommentsStatusAllReturnsEveryThread(t *testing.T) {
	f := newStatusFilterFixture(t)
	got := threadIDs(f.list(t, "all", http.StatusOK))
	if len(got) != 3 || !got[f.orphanedID] || !got[f.attachedID] || !got[f.resolvedID] {
		t.Fatalf("status=all threads = %v, want orphaned, attached and resolved", got)
	}
}

func TestListCommentsStatusOrphanedFollowsPlacement(t *testing.T) {
	f := newStatusFilterFixture(t)
	got := threadIDs(f.list(t, "orphaned", http.StatusOK))
	if len(got) != 1 || !got[f.orphanedID] {
		t.Fatalf("status=orphaned threads = %v, want only %s", got, f.orphanedID)
	}
}

func TestListCommentsStatusOpenAndResolvedFilterOnTheThread(t *testing.T) {
	f := newStatusFilterFixture(t)

	open := threadIDs(f.list(t, "open", http.StatusOK))
	if len(open) != 2 || !open[f.orphanedID] || !open[f.attachedID] {
		t.Fatalf("status=open threads = %v, want orphaned and attached", open)
	}

	resolved := f.list(t, "resolved", http.StatusOK)
	if len(resolved) != 1 || resolved[0].ID != f.resolvedID {
		t.Fatalf("status=resolved threads = %+v, want only %s", resolved, f.resolvedID)
	}
	// The reply is still open, but it belongs to a resolved thread.
	if len(resolved[0].Replies) != 1 || resolved[0].Replies[0].ID != f.replyID {
		t.Fatalf("resolved thread replies = %+v, want %s", resolved[0].Replies, f.replyID)
	}
}

func TestListCommentsRejectsUnknownStatus(t *testing.T) {
	f := newStatusFilterFixture(t)
	for _, status := range []string{"stale", "closed", "OPEN"} {
		f.list(t, status, http.StatusBadRequest)
	}
}

func TestListCommentsWithoutStatusReturnsEveryThread(t *testing.T) {
	f := newStatusFilterFixture(t)
	if got := threadIDs(f.list(t, "", http.StatusOK)); len(got) != 3 {
		t.Fatalf("no status threads = %v, want all 3", got)
	}
}

func TestListCommentsKeepsAResolvedReplyUnderItsOpenThread(t *testing.T) {
	f := newStatusFilterFixture(t)
	ctx := context.Background()
	reply, err := f.e.store.CreateCommentReply(ctx, f.e.doc.ID, f.attachedID, "settled", fixtureCommenter, nil)
	if err != nil {
		t.Fatalf("create reply: %v", err)
	}
	if _, err := f.e.store.UpdateComment(ctx, reply.ID, repo.CommentUpdate{Status: "resolved"}); err != nil {
		t.Fatalf("resolve reply: %v", err)
	}
	for _, status := range []string{"open", "all", ""} {
		for _, th := range f.list(t, status, http.StatusOK) {
			if th.ID != f.attachedID {
				continue
			}
			if len(th.Replies) != 1 || th.Replies[0].ID != reply.ID {
				t.Fatalf("status=%q: open thread replies = %+v, want the resolved reply %s", status, th.Replies, reply.ID)
			}
		}
	}
}
