package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type inboxItem struct {
	Kind       string `json:"kind"`
	DocumentID string `json:"document_id"`
	CommentID  string `json:"comment_id"`
	From       struct {
		ID string `json:"id"`
	} `json:"from"`
	Body string `json:"body"`
}

func inboxOf(t *testing.T, e *testEnv, p auth.Principal) []inboxItem {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/me/inbox", "", map[string]string{"X-Test-Principal": principalHeader(p)})
	assertStatus(t, rr, http.StatusOK)
	var out struct{ Items []inboxItem }
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad inbox response: %v", err)
	}
	return out.Items
}

func wantInbox(t *testing.T, e *testEnv, p auth.Principal, want ...string) []inboxItem {
	t.Helper()
	items := inboxOf(t, e, p)
	got := make([]string, len(items))
	for i, item := range items {
		got[i] = item.Kind + ":" + item.DocumentID + ":" + item.CommentID
	}
	if !slices.Equal(got, want) {
		t.Fatalf("inbox of %s = %v, want %v", p.ID, got, want)
	}
	return items
}

// A thread waits on a principal who wrote in it or whom it mentions, while
// it is open and has a message by someone else that they did not read.
func TestInboxHoldsTheThreadsThatWaitOnThePrincipal(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	thread := "thread:" + e.doc.ID + ":" + e.cmt.ID
	wantInbox(t, e, fixtureCommenter)
	// The viewer did not write in the thread, so it does not wait on them.
	wantInbox(t, e, fixtureViewer)

	if _, err := e.store.CreateCommentReply(ctx, e.doc.ID, e.cmt.ID, "Why three?", fixtureEditor, nil); err != nil {
		t.Fatal(err)
	}
	items := wantInbox(t, e, fixtureCommenter, thread)
	if items[0].From.ID != fixtureEditor.ID || items[0].Body != "Why three?" {
		t.Fatalf("thread item = %+v", items[0])
	}
	// A mention makes it wait on the viewer too.
	mention := []repo.CommentMention{{Principal: fixtureViewer, OffsetUTF16: 0, LengthUTF16: 7, LabelText: "@Viewer"}}
	if _, err := e.store.CreateCommentReply(ctx, e.doc.ID, e.cmt.ID, "@Viewer look", fixtureEditor, mention); err != nil {
		t.Fatal(err)
	}
	wantInbox(t, e, fixtureViewer, thread)
	// The owner gets each thread on their document.
	wantInbox(t, e, fixtureOwner, thread)
	// A message of the viewer reads the messages before it.
	if _, err := e.store.CreateCommentReply(ctx, e.doc.ID, e.cmt.ID, "Seen", fixtureViewer, nil); err != nil {
		t.Fatal(err)
	}
	wantInbox(t, e, fixtureViewer)

	if code := markRead(t, e, e.doc.ID, e.cmt.ID, fixtureCommenter); code != http.StatusNoContent {
		t.Fatalf("mark read = %d", code)
	}
	wantInbox(t, e, fixtureCommenter)

	if _, err := e.store.UpdateComment(ctx, e.cmt.ID, repo.CommentUpdate{Status: "resolved"}); err != nil {
		t.Fatal(err)
	}
	wantInbox(t, e, fixtureOwner)
}

// A document waits on an approver until they decide on its current content.
func TestInboxHoldsTheDocumentsToApprove(t *testing.T) {
	e := newTestEnv(t)
	approval := "approval:" + e.doc.ID + ":"
	mustAssignApprover(t, e, e.doc.ID, fixtureViewer.Email, fixtureOwner)
	items := wantInbox(t, e, fixtureViewer, approval)
	if items[0].From.ID != fixtureOwner.ID {
		t.Fatalf("approval item = %+v, want it from the owner", items[0])
	}

	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
	wantInbox(t, e, fixtureViewer)

	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureOwner)
	wantInbox(t, e, fixtureViewer, approval)
}

// A principal who can no longer read a document finds nothing of it in
// their inbox.
func TestInboxHoldsOnlyReadableDocuments(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	grant, err := e.store.CreateGrant(ctx, "document", e.doc.ID, fixtureStranger, repo.RoleCommenter, fixtureOwner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateCommentReply(ctx, e.doc.ID, e.cmt.ID, "me too", fixtureStranger, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateCommentReply(ctx, e.doc.ID, e.cmt.ID, "noted", fixtureEditor, nil); err != nil {
		t.Fatal(err)
	}
	wantInbox(t, e, fixtureStranger, "thread:"+e.doc.ID+":"+e.cmt.ID)

	if err := e.store.DeleteGrant(ctx, e.doc.ID, grant.ID, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	wantInbox(t, e, fixtureStranger)
}

// Items of documents that the principal cannot read do not take the places
// of those that they can read.
func TestInboxReadsPastUnreadableDocuments(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	if _, err := e.store.CreateCommentReply(ctx, e.doc.ID, e.cmt.ID, "noted", fixtureEditor, nil); err != nil {
		t.Fatal(err)
	}
	other, ver, err := e.store.CreateDocument(ctx, fixtureOwner, "other", "", []byte("<html><body>other</body></html>"))
	if err != nil {
		t.Fatal(err)
	}
	grant, err := e.store.CreateGrant(ctx, "document", other.ID, fixtureCommenter, repo.RoleCommenter, fixtureOwner)
	if err != nil {
		t.Fatal(err)
	}
	for range repo.InboxPage {
		c, err := e.store.CreateComment(ctx, other.ID, ver.ID, "mine", repo.Anchor{Quote: "other"}, 0, fixtureCommenter, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.CreateCommentReply(ctx, other.ID, c.ID, "reply", fixtureOwner, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.store.DeleteGrant(ctx, other.ID, grant.ID, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	wantInbox(t, e, fixtureCommenter, "thread:"+e.doc.ID+":"+e.cmt.ID)
}

// One read of the inbox can read many pages, so each principal has a budget
// of reads.
func TestInboxHasABudgetForEachPrincipal(t *testing.T) {
	e := newTestEnv(t)
	read := func(p auth.Principal) int {
		return do(t, e.h, http.MethodGet, "/v1/me/inbox", "", map[string]string{"X-Test-Principal": principalHeader(p)}).Code
	}
	for i := range 60 {
		if got := read(fixtureViewer); got != http.StatusOK {
			t.Fatalf("read %d: status = %d, want 200", i, got)
		}
	}
	if got := read(fixtureViewer); got != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", got)
	}
	if got := read(fixtureCommenter); got != http.StatusOK {
		t.Fatalf("another principal: status = %d, want 200", got)
	}
}
