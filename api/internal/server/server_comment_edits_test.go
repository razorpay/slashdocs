package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func TestOnlyAuthorCanEditCommentContent(t *testing.T) {
	e := newTestEnv(t)
	reply, err := e.store.CreateCommentReply(context.Background(), e.doc.ID, e.cmt.ID, "reply", fixtureCommenter, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{e.cmt.ID, reply.ID} {
		path := "/v1/documents/" + e.doc.ID + "/comments/" + id
		for _, principal := range []auth.Principal{fixtureOwner, fixtureEditor, fixtureViewer, fixtureAttacker} {
			for _, body := range []string{`{"body":"not mine"}`, `{"mentions":[]}`, `{"body":"not mine","status":"resolved"}`} {
				rr := do(t, e.h, http.MethodPatch, path, body, map[string]string{"Content-Type": commentMentionsContentType, "X-Test-Principal": principalHeader(principal)})
				assertStatus(t, rr, http.StatusForbidden)
			}
		}
		rr := do(t, e.h, http.MethodPatch, path, `{"body":"my edited text"}`, map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)})
		assertStatus(t, rr, http.StatusOK)
		assertRFC3339Timestamp(t, jsonField(t, rr.Body.Bytes(), "edited_at"))
		if jsonField(t, rr.Body.Bytes(), "body") != "my edited text" {
			t.Fatal("edit not saved")
		}
		// Editors can still resolve a thread; that does not count as a content edit.
		editedAt := jsonField(t, rr.Body.Bytes(), "edited_at")
		rr = do(t, e.h, http.MethodPatch, path, `{"status":"resolved"}`, map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureEditor)})
		assertStatus(t, rr, http.StatusOK)
		if jsonField(t, rr.Body.Bytes(), "edited_at") != editedAt {
			t.Fatal("resolving changed edit time")
		}
	}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", map[string]string{"X-Test-Principal": principalHeader(fixtureCommenter)})
	assertStatus(t, rr, http.StatusOK)
	var listed struct {
		Items []struct {
			EditedAt string `json:"edited_at"`
			Replies  []struct {
				EditedAt string `json:"edited_at"`
			} `json:"replies"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || len(listed.Items[0].Replies) != 1 {
		t.Fatalf("unexpected threads: %s", rr.Body.String())
	}
	assertRFC3339Timestamp(t, listed.Items[0].EditedAt)
	assertRFC3339Timestamp(t, listed.Items[0].Replies[0].EditedAt)
}
