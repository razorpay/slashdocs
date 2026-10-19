package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const editFixtureHTML = "<html><body>\n  <p>Cache TTL of 10 minutes.</p>\n  <p>Retry  twice.</p>\n</body></html>"

func postEdits(t *testing.T, e *testEnv, docID string, p auth.Principal, body any) (int, []byte) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/edits", string(b), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(p),
	})
	return rr.Code, rr.Body.Bytes()
}

// createEditableDocument creates a document the fixture editor may edit.
func createEditableDocument(t *testing.T, e *testEnv) (docID, verID string) {
	t.Helper()
	docID, verID = e.createDocument("Edits", editFixtureHTML, fixtureOwner)
	if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureEditor, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	return docID, verID
}

func versionHTML(t *testing.T, e *testEnv, docID, versionID string) string {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/versions/"+versionID+"/html", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusOK)
	return rr.Body.String()
}

func TestEditDocumentReplacesTextAndKeepsTheRest(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Edits", editFixtureHTML, fixtureOwner)

	status, body := postEdits(t, e, docID, fixtureOwner, map[string]any{
		"base_version_id": verID,
		"edits":           []map[string]string{{"old_string": "TTL of 10 minutes", "new_string": "TTL of 5 minutes"}},
	})
	if status != http.StatusCreated {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	var out struct {
		ID            string `json:"id"`
		Number        int    `json:"number"`
		ChangeSummary string `json:"change_summary"`
		BaseVersionID string `json:"base_version_id"`
		EditsApplied  int    `json:"edits_applied"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Number != 2 || out.BaseVersionID != verID || out.EditsApplied != 1 {
		t.Fatalf("response = %+v", out)
	}
	// The history says what changed even when the caller gave no summary.
	if out.ChangeSummary != `Replaced "TTL of 10 minutes" with "TTL of 5 minutes"` {
		t.Fatalf("change_summary = %q", out.ChangeSummary)
	}
	want := "<html><body>\n  <p>Cache TTL of 5 minutes.</p>\n  <p>Retry  twice.</p>\n</body></html>"
	if got := versionHTML(t, e, docID, out.ID); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
}

func TestEditDocumentReplaceAllChangesEveryOccurrence(t *testing.T) {
	e := newTestEnv(t)
	docID, _ := e.createDocument("Edits", editFixtureHTML, fixtureOwner)

	status, body := postEdits(t, e, docID, fixtureOwner, map[string]any{
		"edits": []map[string]any{{"old_string": "<p>", "new_string": "<p class=\"note\">", "replace_all": true}},
	})
	if status != http.StatusCreated {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	want := "<html><body>\n  <p class=\"note\">Cache TTL of 10 minutes.</p>\n  <p class=\"note\">Retry  twice.</p>\n</body></html>"
	if got := versionHTML(t, e, docID, jsonField(t, body, "id")); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
	if got := jsonField(t, body, "change_summary"); got != `Replaced "<p>" with "<p class=\"note\">" everywhere` {
		t.Fatalf("change_summary = %q", got)
	}
}

func TestEditDocumentWithoutBaseAppliesToTheCurrentVersion(t *testing.T) {
	e := newTestEnv(t)
	docID, _ := createEditableDocument(t, e)

	// Two writers editing different text both land, in either order.
	status, body := postEdits(t, e, docID, fixtureOwner, map[string]any{
		"edits": []map[string]string{{"old_string": "10 minutes", "new_string": "5 minutes"}},
	})
	if status != http.StatusCreated {
		t.Fatalf("first edit status = %d; body=%s", status, body)
	}
	status, body = postEdits(t, e, docID, fixtureEditor, map[string]any{
		"change_summary": "Retry three times",
		"edits":          []map[string]string{{"old_string": "Retry  twice", "new_string": "Retry three times"}},
	})
	if status != http.StatusCreated {
		t.Fatalf("second edit status = %d; body=%s", status, body)
	}
	want := "<html><body>\n  <p>Cache TTL of 5 minutes.</p>\n  <p>Retry three times.</p>\n</body></html>"
	if got := versionHTML(t, e, docID, jsonField(t, body, "id")); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
	if got := jsonField(t, body, "change_summary"); got != "Retry three times" {
		t.Fatalf("change_summary = %q", got)
	}
}

func TestEditDocumentFailsCleanly(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := createEditableDocument(t, e)

	cases := []struct {
		name  string
		edits []map[string]string
		want  string
	}{
		{"not found", []map[string]string{{"old_string": "TTL of 15 minutes", "new_string": "x"}}, fmt.Sprintf(`{
		  "error": {
		    "code": "edit_failed",
		    "message": "edit 0: old_string was not found in the document",
		    "details": { "index": 0, "reason": "not_found", "matches": 0, "current_version_id": %q }
		  }
		}`, verID)},
		{"ambiguous", []map[string]string{
			{"old_string": "Cache", "new_string": "Store"},
			{"old_string": "<p>", "new_string": "<p class=x>"},
		}, fmt.Sprintf(`{
		  "error": {
		    "code": "edit_failed",
		    "message": "edit 1: old_string occurs 2 times; include more surrounding text so it matches exactly once, or set replace_all to replace every one",
		    "details": { "index": 1, "reason": "ambiguous", "matches": 2, "current_version_id": %q }
		  }
		}`, verID)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := postEdits(t, e, docID, fixtureEditor, map[string]any{"edits": tc.edits})
			if status != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d; body=%s", status, body)
			}
			assertJSON(t, body, tc.want)
		})
	}
	// Nothing was saved: the first edit of a failed batch does not apply.
	if got := versionHTML(t, e, docID, verID); got != editFixtureHTML {
		t.Fatalf("html changed to %q", got)
	}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/versions", "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
	var versions struct {
		Items []any `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &versions); err != nil || len(versions.Items) != 1 {
		t.Fatalf("versions = %s", rr.Body.String())
	}
}

func TestEditDocumentRejectsAStaleBase(t *testing.T) {
	e := newTestEnv(t)
	status, body := postEdits(t, e, e.doc.ID, fixtureEditor, map[string]any{
		"base_version_id": "ver_old",
		"edits":           []map[string]string{{"old_string": "fixture", "new_string": "changed"}},
	})
	if status != http.StatusConflict {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	assertJSON(t, body, fmt.Sprintf(`{
	  "error": {
	    "code": "version_conflict",
	    "message": "base_version_id is stale",
	    "details": { "current_version_id": %q }
	  }
	}`, e.ver.ID))
}

func TestEditDocumentValidatesTheRequest(t *testing.T) {
	e := newTestEnv(t)
	tooMany := make([]map[string]string, 101)
	for i := range tooMany {
		tooMany[i] = map[string]string{"old_string": "a", "new_string": "b"}
	}
	for _, body := range []any{
		map[string]any{},
		map[string]any{"edits": []any{}},
		map[string]any{"edits": tooMany},
		map[string]any{"edits": "fixture"},
	} {
		status, out := postEdits(t, e, e.doc.ID, fixtureEditor, body)
		if status != http.StatusBadRequest {
			t.Fatalf("body %v: status = %d; body=%s", body, status, out)
		}
	}
}

func TestEditDocumentNeedsEditorRole(t *testing.T) {
	e := newTestEnv(t)
	for _, p := range []auth.Principal{fixtureViewer, fixtureCommenter} {
		status, body := postEdits(t, e, e.doc.ID, p, map[string]any{
			"edits": []map[string]string{{"old_string": "fixture", "new_string": "changed"}},
		})
		if status != http.StatusForbidden {
			t.Fatalf("%s: status = %d; body=%s", p.ID, status, body)
		}
	}
	// A stranger learns nothing about the document's text.
	status, _ := postEdits(t, e, e.doc.ID, fixtureStranger, map[string]any{
		"edits": []map[string]string{{"old_string": "fixture", "new_string": "changed"}},
	})
	if status != http.StatusForbidden && status != http.StatusNotFound {
		t.Fatalf("stranger status = %d", status)
	}
}
