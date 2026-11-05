package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

func assertRFC3339Timestamp(t *testing.T, value string) {
	t.Helper()
	if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
		t.Fatalf("timestamp %q is not RFC3339: %v", value, err)
	}
}

func TestCommentAuthorNeedsCurrentDocumentAccess(t *testing.T) {
	for _, role := range []string{"revoked", "viewer"} {
		t.Run(role, func(t *testing.T) {
			e := newTestEnv(t)
			grants, err := e.store.ListGrants(context.Background(), e.doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, grant := range grants {
				if grant.Principal.ID == fixtureCommenter.ID {
					rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+grant.ID, "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
					assertStatus(t, rr, http.StatusNoContent)
				}
			}
			if role == "viewer" {
				rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{"principal":{"type":"user","id":%q},"role":"viewer"}`, fixtureCommenter.ID), map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureOwner)})
				assertStatus(t, rr, http.StatusCreated)
			}
			path := "/v1/documents/" + e.doc.ID + "/comments/" + e.cmt.ID
			for _, mutation := range []struct{ method, suffix, body string }{
				{http.MethodPatch, "", `{"body":"changed"}`},
				{http.MethodPatch, "", `{"status":"resolved"}`},
				{http.MethodPatch, "", `{"status":"open"}`},
				{http.MethodDelete, "", ""},
				{http.MethodPost, "/replies", `{"body":"reply"}`},
				{http.MethodPut, "/reactions/heart", ""},
				{http.MethodDelete, "/reactions/heart", ""},
			} {
				rr := do(t, e.h, mutation.method, path+mutation.suffix, mutation.body, map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)})
				assertStatus(t, rr, http.StatusForbidden)
			}
		})
	}
}

func TestCreateComment(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", fmt.Sprintf(`{
	  "version_id": %q,
	  "body": "Add a number here.",
	  "anchor": {
	    "quote": "fixture",
	    "prefix": "",
	    "suffix": "",
	    "dom_path": "html/body",
	    "start_offset": 0,
	    "end_offset": 7
	  }
	}`, e.ver.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusCreated)
	cmtID := jsonField(t, rr.Body.Bytes(), "id")
	createdAt := jsonField(t, rr.Body.Bytes(), "created_at")
	assertRFC3339Timestamp(t, createdAt)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "id": %q,
		  "author": { "type": "user", "id": "commenter_1", "email": "commenter@example.com", "name": "Commenter" },
		  "body": "Add a number here.",
		  "mentions": [],
		  "reactions": [],
		  "selected_text": "fixture",
	  "anchor": {
	    "quote": "fixture",
	    "prefix": "",
	    "suffix": "",
	    "dom_path": "html/body",
	    "start_offset": 0,
	    "end_offset": 7
	  },
	  "status": "open",
	  "created_at": %q,
	  "created_on_version_id": %q,
	  "current_placement": {
	    "version_id": %q,
	    "status": "attached",
	    "anchor": {
	      "quote": "fixture",
	      "prefix": "",
	      "suffix": "",
	      "dom_path": "html/body",
	      "start_offset": 0,
	      "end_offset": 7
	    },
	    "matched_text": "fixture",
	    "confidence": 1
	  }
	}`, cmtID, createdAt, e.ver.ID, e.ver.ID))
}

func TestCreateCommentReplyAndListThread(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID+"/replies", `{"body":"reply body"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusCreated)
	replyID := jsonField(t, rr.Body.Bytes(), "id")
	replyCreatedAt := jsonField(t, rr.Body.Bytes(), "created_at")
	assertRFC3339Timestamp(t, replyCreatedAt)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "id": %q,
		  "author": { "type": "user", "id": "commenter_1", "email": "commenter@example.com", "name": "Commenter" },
		  "body": "reply body",
		  "mentions": [],
		  "reactions": [],
		  "status": "open",
	  "created_at": %q,
	  "created_on_version_id": %q,
	  "parent_comment_id": %q
	}`, replyID, replyCreatedAt, e.ver.ID, e.cmt.ID))

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "items": [{
	    "id": %q,
		    "author": { "type": "user", "id": "commenter_1", "email": "commenter@example.com", "name": "Commenter" },
		    "body": "original",
		    "mentions": [],
		    "reactions": [],
		    "selected_text": "fixture",
	    "anchor": { "quote": "fixture", "prefix": "", "suffix": "", "dom_path": "", "start_offset": 0, "end_offset": 0 },
	    "status": "open",
	    "created_at": %q,
	    "created_on_version_id": %q,
	    "current_placement": { "version_id": %q, "status": "attached", "anchor": { "quote": "fixture", "prefix": "", "suffix": "", "dom_path": "", "start_offset": 0, "end_offset": 0 }, "matched_text": "fixture", "confidence": 1 },
	    "replies": [{
	      "id": %q,
		      "author": { "type": "user", "id": "commenter_1", "email": "commenter@example.com", "name": "Commenter" },
		      "body": "reply body",
		      "mentions": [],
		      "reactions": [],
		      "status": "open",
	      "created_at": %q,
	      "created_on_version_id": %q,
	      "parent_comment_id": %q
	    }]
	  }]
	}`, e.cmt.ID, e.cmt.CreatedAt, e.ver.ID, e.ver.ID, replyID, replyCreatedAt, e.ver.ID, e.cmt.ID))
}

func TestViewerCannotCreateComment(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", fmt.Sprintf(`{
	  "version_id": %q,
	  "body": "should not be allowed",
	  "anchor": { "quote": "hello" }
	}`, e.ver.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureViewer),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestCreateCommentRejectsVersionFromAnotherDocument(t *testing.T) {
	e := newTestEnv(t)
	_, otherVerID := e.createDocument("Other", "<html>other</html>", fixtureOwner)

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", fmt.Sprintf(`{
	  "version_id": %q,
	  "body": "wrong doc",
	  "anchor": { "quote": "hello" }
	}`, otherVerID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusNotFound)
}

func TestRandomUserCannotPatchAnotherUsersComment(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, `{"body":"hacked"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureAttacker),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestRandomUserCannotDeleteAnotherUsersComment(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureAttacker),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestEditorCannotDeleteAnotherUsersComment(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureEditor),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestPatchCommentRejectsWrongDocument(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/doc_wrong/comments/"+e.cmt.ID, `{"status":"resolved"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusNotFound)
}

// An edit names the body that it started from. A client that did not see a
// newer body gets 409 and does not replace it. A patch without base_body, as
// from the CLI or MCP, still applies.
func TestPatchCommentRefusesAStaleEdit(t *testing.T) {
	e := newTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/comments/" + e.cmt.ID
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}

	rr := do(t, e.h, http.MethodPatch, path, `{"body":"from tab A","base_body":"original"}`, headers)
	assertStatus(t, rr, http.StatusOK)
	rr = do(t, e.h, http.MethodPatch, path, `{"body":"from tab B","base_body":"original"}`, headers)
	assertStatus(t, rr, http.StatusConflict)
	if !strings.Contains(rr.Body.String(), `"comment_changed"`) {
		t.Fatalf("body = %s, want the comment_changed code", rr.Body.String())
	}
	got, err := e.store.GetComment(context.Background(), e.cmt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Body != "from tab A" {
		t.Fatalf("body = %q, want the newer edit to stay", got.Body)
	}
	rr = do(t, e.h, http.MethodPatch, path, `{"body":"from the CLI"}`, headers)
	assertStatus(t, rr, http.StatusOK)
}

func TestPatchCommentRejectsInvalidStatus(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, `{"status":"closed"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusBadRequest)
}

// The fixture comment is an open thread. The test adds a resolved thread
// whose reply is still stored as open: replies travel with their thread.
func TestListCommentsFiltersThreadsByStatus(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	resolved, err := e.store.CreateComment(ctx, e.doc.ID, e.ver.ID, "resolved", repo.Anchor{Quote: "fixture"}, fixtureCommenter, nil)
	if err != nil {
		t.Fatal(err)
	}
	reply, err := e.store.CreateCommentReply(ctx, e.doc.ID, resolved.ID, "still talking", fixtureCommenter, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.UpdateComment(ctx, resolved.ID, repo.CommentUpdate{Status: "resolved"}); err != nil {
		t.Fatal(err)
	}
	openThread := e.cmt.ID + "[]"
	resolvedThread := resolved.ID + "[" + reply.ID + "]"
	for _, tc := range []struct{ status, want string }{
		{"", openThread + " " + resolvedThread},
		{"all", openThread + " " + resolvedThread},
		{"open", openThread},
		{"resolved", resolvedThread},
	} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments?status="+tc.status, "", map[string]string{"X-Test-Principal": principalHeader(fixtureCommenter)})
		assertStatus(t, rr, http.StatusOK)
		var list struct {
			Items []commentWire `json:"items"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		threads := make([]string, 0, len(list.Items))
		for _, item := range list.Items {
			replies := make([]string, 0, len(item.Replies))
			for _, r := range item.Replies {
				replies = append(replies, r.ID)
			}
			threads = append(threads, item.ID+"["+strings.Join(replies, ",")+"]")
		}
		if got := strings.Join(threads, " "); got != tc.want {
			t.Errorf("status=%q: got %s, want %s", tc.status, got, tc.want)
		}
	}
}

func TestListCommentsRejectsUnknownStatus(t *testing.T) {
	e := newTestEnv(t)
	for _, status := range []string{"stale", "orphaned", "OPEN"} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments?status="+status, "", map[string]string{"X-Test-Principal": principalHeader(fixtureCommenter)})
		assertStatus(t, rr, http.StatusBadRequest)
	}
}
