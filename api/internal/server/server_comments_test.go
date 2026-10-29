package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

func TestPatchCommentRejectsInvalidStatus(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, `{"status":"closed"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusBadRequest)
}

func TestCreateCommentAnchorValidation(t *testing.T) {
	e := newTestEnv(t)
	doc, ver, err := e.store.CreateDocument(context.Background(), fixtureOwner, "anchors_doc", []byte("<h1>Anchors</h1><p>Plan A: TBD</p><p>Plan B: TBD</p><p>Plan C: done</p>"))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	if _, err := e.store.CreateGrant(context.Background(), "document", doc.ID, fixtureCommenter, repo.RoleCommenter, fixtureOwner); err != nil {
		t.Fatalf("grant: %v", err)
	}

	t.Run("missing quote returns 400 anchor_not_found", func(t *testing.T) {
		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+doc.ID+"/comments", fmt.Sprintf(`{
			"version_id": %q,
			"body": "Comment on missing text",
			"anchor": { "quote": "this text is not in the document" }
		}`, ver.ID), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureCommenter),
		})
		assertStatus(t, rr, http.StatusBadRequest)
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil || body.Error.Code != "anchor_not_found" {
			t.Fatalf("expected error.code anchor_not_found, got %s", rr.Body.String())
		}
	})

	t.Run("repeated quote without disambiguation returns 400 anchor_ambiguous", func(t *testing.T) {
		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+doc.ID+"/comments", fmt.Sprintf(`{
			"version_id": %q,
			"body": "Comment on ambiguous TBD",
			"anchor": { "quote": "TBD" }
		}`, ver.ID), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureCommenter),
		})
		assertStatus(t, rr, http.StatusBadRequest)
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil || body.Error.Code != "anchor_ambiguous" {
			t.Fatalf("expected error.code anchor_ambiguous, got %s", rr.Body.String())
		}
	})

	t.Run("repeated quote with disambiguating prefix succeeds", func(t *testing.T) {
		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+doc.ID+"/comments", fmt.Sprintf(`{
			"version_id": %q,
			"body": "Comment on Plan B TBD",
			"anchor": { "quote": "TBD", "prefix": "Plan B: " }
		}`, ver.ID), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureCommenter),
		})
		assertStatus(t, rr, http.StatusCreated)
		var resp map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		placement, _ := resp["current_placement"].(map[string]any)
		if placement == nil || placement["status"] != "attached" || placement["confidence"] != float64(1) {
			t.Fatalf("expected attached with confidence 1, got %#v", placement)
		}
	})

	t.Run("unique quote succeeds", func(t *testing.T) {
		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+doc.ID+"/comments", fmt.Sprintf(`{
			"version_id": %q,
			"body": "Plan C comment",
			"anchor": { "quote": "Plan C: done" }
		}`, ver.ID), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureCommenter),
		})
		assertStatus(t, rr, http.StatusCreated)
		var resp map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		placement, _ := resp["current_placement"].(map[string]any)
		if placement == nil || placement["status"] != "attached" || placement["matched_text"] != "Plan C: done" {
			t.Fatalf("expected attached with matched_text Plan C: done, got %#v", placement)
		}
	})

	t.Run("unknown version returns 404", func(t *testing.T) {
		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+doc.ID+"/comments", `{
			"version_id": "ver_nonexistent",
			"body": "Comment",
			"anchor": { "quote": "Plan C: done" }
		}`, map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureCommenter),
		})
		assertStatus(t, rr, http.StatusNotFound)
	})

	t.Run("version belonging to another document returns 404", func(t *testing.T) {
		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", fmt.Sprintf(`{
			"version_id": %q,
			"body": "Cross-doc comment",
			"anchor": { "quote": "Plan C: done" }
		}`, ver.ID), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureCommenter),
		})
		assertStatus(t, rr, http.StatusNotFound)
	})
}
