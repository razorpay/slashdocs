package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func readPath(docID, threadID string) string {
	return "/v1/documents/" + docID + "/comments/" + threadID + "/read"
}

func markRead(t *testing.T, e *testEnv, docID, threadID string, p auth.Principal) int {
	t.Helper()
	return do(t, e.h, http.MethodPut, readPath(docID, threadID), "", map[string]string{
		"X-Test-Principal": principalHeader(p),
	}).Code
}

// unreadOf tells, for each thread of the fixture document, whether the
// reader sees it unread. A nil reader lists the comments signed out.
func unreadOf(t *testing.T, e *testEnv, reader *auth.Principal) map[string]any {
	t.Helper()
	headers := map[string]string{}
	if reader != nil {
		headers["X-Test-Principal"] = principalHeader(*reader)
	}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", headers)
	assertStatus(t, rr, http.StatusOK)
	var out struct {
		Items []struct {
			ID     string `json:"id"`
			Unread any    `json:"unread"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad comments response: %v", err)
	}
	unread := map[string]any{}
	for _, item := range out.Items {
		unread[item.ID] = item.Unread
	}
	return unread
}

func reply(t *testing.T, e *testEnv, author auth.Principal) repo.Comment {
	t.Helper()
	r, err := e.store.CreateCommentReply(context.Background(), e.doc.ID, e.cmt.ID, "reply", author, nil)
	if err != nil {
		t.Fatalf("reply: %v", err)
	}
	return r
}

// A thread is unread until the reader marks it read, and again when someone
// else replies. The reader's own messages never make it unread, and each
// reader has their own marks.
func TestCommentThreadUnreadRule(t *testing.T) {
	e := newTestEnv(t)
	if got := unreadOf(t, e, &fixtureCommenter)[e.cmt.ID]; got != nil {
		t.Fatalf("author sees own thread unread = %v, want no unread", got)
	}
	for _, p := range []auth.Principal{fixtureViewer, fixtureEditor} {
		if got := unreadOf(t, e, &p)[e.cmt.ID]; got != true {
			t.Fatalf("%s sees a new thread unread = %v, want true", p.ID, got)
		}
	}

	if code := markRead(t, e, e.doc.ID, e.cmt.ID, fixtureViewer); code != http.StatusNoContent {
		t.Fatalf("mark read = %d, want 204", code)
	}
	if got := unreadOf(t, e, &fixtureViewer)[e.cmt.ID]; got != nil {
		t.Fatalf("viewer after mark = %v, want read", got)
	}
	if got := unreadOf(t, e, &fixtureEditor)[e.cmt.ID]; got != true {
		t.Fatalf("editor after the viewer's mark = %v, want still unread", got)
	}

	if code := markRead(t, e, e.doc.ID, e.cmt.ID, fixtureEditor); code != http.StatusNoContent {
		t.Fatalf("editor mark read = %d, want 204", code)
	}
	reply(t, e, fixtureEditor)
	if got := unreadOf(t, e, &fixtureEditor)[e.cmt.ID]; got != nil {
		t.Fatalf("editor after own reply = %v, want read", got)
	}
	if got := unreadOf(t, e, &fixtureViewer)[e.cmt.ID]; got != true {
		t.Fatalf("viewer after the editor's reply = %v, want unread", got)
	}
}

// Only a reader who can view the document marks its threads, and only its
// threads: a reply, a thread of another document, or a missing one is 404.
func TestMarkCommentThreadReadAccess(t *testing.T) {
	e := newTestEnv(t)
	r := reply(t, e, fixtureEditor)
	other, otherVer, err := e.store.CreateDocument(context.Background(), fixtureOwner, "other", "", []byte("<html><body>other</body></html>"))
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := e.store.CreateComment(context.Background(), other.ID, otherVer.ID, "elsewhere", repo.Anchor{Quote: "other"}, 0, fixtureOwner, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name     string
		docID    string
		threadID string
		p        auth.Principal
		want     int
	}{
		{"stranger", e.doc.ID, e.cmt.ID, fixtureStranger, http.StatusForbidden},
		{"missing document", "doc_missing", e.cmt.ID, fixtureViewer, http.StatusNotFound},
		{"reply", e.doc.ID, r.ID, fixtureViewer, http.StatusNotFound},
		{"thread of another document", e.doc.ID, foreign.ID, fixtureViewer, http.StatusNotFound},
		{"missing thread", e.doc.ID, "cmt_missing", fixtureViewer, http.StatusNotFound},
		{"service account without a grant", e.doc.ID, e.cmt.ID, auth.Principal{Type: auth.PrincipalServiceAccount, ID: e.sa.ID}, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code := markRead(t, e, tc.docID, tc.threadID, tc.p); code != tc.want {
				t.Fatalf("mark read = %d, want %d", code, tc.want)
			}
		})
	}
	if got := unreadOf(t, e, &fixtureViewer)[e.cmt.ID]; got != true {
		t.Fatalf("viewer after refused marks = %v, want unread", got)
	}
}

// A signed-out reader gets no read state and cannot mark threads.
func TestSignedOutReaderHasNoReadState(t *testing.T) {
	e := newTestEnv(t)
	e.shareWithAnyone("viewer")
	if got := unreadOf(t, e, nil)[e.cmt.ID]; got != nil {
		t.Fatalf("anonymous unread = %v, want none", got)
	}
	rr := do(t, e.h, http.MethodPut, readPath(e.doc.ID, e.cmt.ID), "", nil)
	assertStatus(t, rr, http.StatusUnauthorized)
}
