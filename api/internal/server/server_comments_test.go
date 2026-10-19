package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
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

func TestPatchCommentRejectsInvalidStatus(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, `{"status":"closed"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusBadRequest)
}

func TestListCommentsStatusFilter(t *testing.T) {
	e := newTestEnv(t)

	// e.cmt is already open. Let's create a second comment and resolve it.
	create := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", fmt.Sprintf(`{
	  "version_id": %q,
	  "body": "second comment",
	  "anchor": { "quote": "fixture", "prefix": "", "suffix": "" }
	}`, e.ver.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, create, http.StatusCreated)
	cmt2ID := jsonField(t, create.Body.Bytes(), "id")

	// Resolve the second comment
	patch := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+cmt2ID, `{"status":"resolved"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, patch, http.StatusOK)

	// Filter open: should return only e.cmt
	rrOpen := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments?status=open", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rrOpen, http.StatusOK)
	var gotOpen struct {
		Items []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rrOpen.Body.Bytes(), &gotOpen); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(gotOpen.Items) != 1 || gotOpen.Items[0].ID != e.cmt.ID || gotOpen.Items[0].Status != "open" {
		t.Fatalf("expected 1 open comment (%s), got: %+v", e.cmt.ID, gotOpen.Items)
	}

	// Filter resolved: should return only cmt2ID
	rrResolved := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments?status=resolved", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rrResolved, http.StatusOK)
	var gotResolved struct {
		Items []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rrResolved.Body.Bytes(), &gotResolved); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(gotResolved.Items) != 1 || gotResolved.Items[0].ID != cmt2ID || gotResolved.Items[0].Status != "resolved" {
		t.Fatalf("expected 1 resolved comment (%s), got: %+v", cmt2ID, gotResolved.Items)
	}

	// Filter all: should return both comments
	rrAll := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments?status=all", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rrAll, http.StatusOK)
	var gotAll struct {
		Items []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rrAll.Body.Bytes(), &gotAll); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(gotAll.Items) != 2 {
		t.Fatalf("expected 2 comments with status=all, got: %+v", gotAll.Items)
	}

	// Omitted filter: should return both comments
	rrDefault := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rrDefault, http.StatusOK)
	var gotDefault struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rrDefault.Body.Bytes(), &gotDefault); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(gotDefault.Items) != 2 {
		t.Fatalf("expected 2 comments with default filter, got: %+v", gotDefault.Items)
	}

	// Invalid status filters (including phantom stale, orphaned, and bogus values)
	for _, bad := range []string{"stale", "orphaned", "closed", "invalid"} {
		rrBad := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments?status="+bad, "", map[string]string{
			"X-Test-Principal": principalHeader(fixtureCommenter),
		})
		assertStatus(t, rrBad, http.StatusBadRequest)
		assertJSON(t, rrBad.Body.Bytes(), `{
		  "error": { "code": "bad_request", "message": "invalid comment status" }
		}`)
	}
}
