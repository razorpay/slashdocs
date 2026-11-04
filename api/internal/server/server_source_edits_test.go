package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const sourceFixtureHTML = "<html><body>\n<h1>Café 😀</h1>\n<p>Try it.</p>\n<p>Middle.</p>\n<p>Try it.</p>\n</body></html>"

type sourceEdited struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	SHA256        string `json:"sha256"`
	ChangeSummary string `json:"change_summary"`
	BaseVersionID string `json:"base_version_id"`
	Rebased       bool   `json:"rebased"`
}

func postSourceEdits(t *testing.T, h http.Handler, docID string, p auth.Principal, body any) (int, []byte) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rr := do(t, h, http.MethodPost, "/v1/documents/"+docID+"/source-edits", string(b), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(p),
	})
	return rr.Code, rr.Body.Bytes()
}

// replaceAt replaces the n-th occurrence, from zero, of old in html with with.
func replaceAt(html, old, with string, n int) map[string]any {
	start := 0
	for i := 0; i <= n; i++ {
		start += strings.Index(html[start:], old) + 1
	}
	start--
	return map[string]any{"start": start, "end": start + len(old), "old_html": old, "new_html": with}
}

// editSource posts the source edits as the owner and returns the version
// they made.
func editSource(t *testing.T, h http.Handler, docID string, body any) sourceEdited {
	t.Helper()
	status, out := postSourceEdits(t, h, docID, fixtureOwner, body)
	if status != http.StatusCreated {
		t.Fatalf("status = %d; body=%s", status, out)
	}
	var v sourceEdited
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func versionCount(t *testing.T, e *testEnv, docID string) int {
	t.Helper()
	versions, err := e.store.ListVersions(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	return len(versions)
}

func TestEditSourceReplacesByPosition(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)

	// Only the second of the two equal labels changes, and a new paragraph
	// goes after it.
	end := strings.LastIndex(sourceFixtureHTML, "\n</body>")
	out := editSource(t, e.h, docID, map[string]any{
		"base_version_id":  verID,
		"client_change_id": "chg_position",
		"replacements": []map[string]any{
			replaceAt(sourceFixtureHTML, "Try it.", "Run it.", 1),
			{"start": end, "end": end, "old_html": "", "new_html": "\n<p>New <b>words</b></p>"},
		},
	})
	if out.Number != 2 || out.BaseVersionID != verID || out.Rebased {
		t.Fatalf("response = %+v", out)
	}
	if want := "Replaced \"Try it.\" with \"Run it.\"\nAdded \"New words\""; out.ChangeSummary != want {
		t.Fatalf("change_summary = %q, want %q", out.ChangeSummary, want)
	}
	want := "<html><body>\n<h1>Café 😀</h1>\n<p>Try it.</p>\n<p>Middle.</p>\n<p>Run it.</p>\n<p>New <b>words</b></p>\n</body></html>"
	if got := versionHTML(t, e, docID, out.ID); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
}

func TestEditSourceRebasesOntoANewerVersion(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	// An agent changes the multi-byte heading before both replacements and
	// the paragraph between them.
	status, body := postEdits(t, e, docID, fixtureOwner, map[string]any{"edits": []map[string]string{
		{"old_string": "Café 😀", "new_string": "Crème brûlée 😀😀"},
		{"old_string": "Middle.", "new_string": "Between the two."},
	}})
	if status != http.StatusCreated {
		t.Fatalf("agent edit status = %d; body=%s", status, body)
	}
	agentVersion := jsonField(t, body, "id")

	out := editSource(t, e.h, docID, map[string]any{
		"base_version_id":  verID,
		"client_change_id": "chg_rebase",
		"change_summary":   "Rename the labels",
		"replacements": []map[string]any{
			replaceAt(sourceFixtureHTML, "Try it.", "First.", 0),
			replaceAt(sourceFixtureHTML, "Try it.", "Last.", 1),
		},
	})
	if out.Number != 3 || out.BaseVersionID != agentVersion || !out.Rebased || out.ChangeSummary != "Rename the labels" {
		t.Fatalf("response = %+v", out)
	}
	want := "<html><body>\n<h1>Crème brûlée 😀😀</h1>\n<p>First.</p>\n<p>Between the two.</p>\n<p>Last.</p>\n</body></html>"
	if got := versionHTML(t, e, docID, out.ID); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
}

func TestEditSourceRefusesAReplacementThatANewerVersionChanged(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	status, body := postEdits(t, e, docID, fixtureOwner, map[string]any{"edits": []map[string]string{
		{"old_string": "Middle.", "new_string": "Their middle."},
	}})
	if status != http.StatusCreated {
		t.Fatalf("agent edit status = %d; body=%s", status, body)
	}
	theirs := jsonField(t, body, "id")

	status, body = postSourceEdits(t, e.h, docID, fixtureOwner, map[string]any{
		"base_version_id":  verID,
		"client_change_id": "chg_conflict",
		"replacements": []map[string]any{
			replaceAt(sourceFixtureHTML, "Try it.", "First.", 0),
			replaceAt(sourceFixtureHTML, "Middle.", "My middle.", 0),
		},
	})
	if status != http.StatusConflict {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	assertJSON(t, body, fmt.Sprintf(`{
	  "error": {
	    "code": "edit_conflict",
	    "message": "replacement 1: a newer version changed the same part of the document",
	    "details": { "current_version_id": %q, "index": 1 }
	  }
	}`, theirs))
	// Nothing was saved, and the other writer's version stays the latest.
	if n := versionCount(t, e, docID); n != 2 {
		t.Fatalf("versions = %d, want 2", n)
	}
	if got := versionHTML(t, e, docID, theirs); got != strings.Replace(sourceFixtureHTML, "Middle.", "Their middle.", 1) {
		t.Fatalf("their version changed to %q", got)
	}
}

func TestEditSourceRetryReturnsTheVersionItMade(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	request := map[string]any{
		"base_version_id":  verID,
		"client_change_id": "chg_retry",
		"replacements":     []map[string]any{replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0)},
	}
	first := editSource(t, e.h, docID, request)
	// Another writer lands before the retry. The retry still returns the
	// first version, as made on the base.
	if status, body := postEdits(t, e, docID, fixtureOwner, map[string]any{"edits": []map[string]string{
		{"old_string": "Café", "new_string": "Coffee"},
	}}); status != http.StatusCreated {
		t.Fatalf("agent edit status = %d; body=%s", status, body)
	}
	again := editSource(t, e.h, docID, request)
	if again != first || again.BaseVersionID != verID || again.Rebased {
		t.Fatalf("retry = %+v, want %+v", again, first)
	}
	if n := versionCount(t, e, docID); n != 3 {
		t.Fatalf("versions = %d, want 3", n)
	}
}

// racingRepo saves another attempt of the same change just before the first
// save of this attempt, as when two attempts run at the same time.
type racingRepo struct {
	repo.Repository
	race func()
}

func (r *racingRepo) CreateVersion(ctx context.Context, documentID, baseVersionID, clientChangeID, changeSummary string, html []byte, createdBy auth.Principal) (repo.Version, error) {
	if race := r.race; race != nil {
		r.race = nil
		race()
	}
	return r.Repository.CreateVersion(ctx, documentID, baseVersionID, clientChangeID, changeSummary, html, createdBy)
}

func TestEditSourceConcurrentAttemptsMakeOneVersion(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	request := map[string]any{
		"base_version_id":  verID,
		"client_change_id": "chg_race",
		"replacements":     []map[string]any{replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0)},
	}
	var first sourceEdited
	h := server.New(server.Config{Environment: "test"},
		server.WithRepository(&racingRepo{Repository: e.store, race: func() {
			first = editSource(t, e.h, docID, request)
		}}),
		server.WithAuthenticator(testPrincipalAuth{}),
	).Handler()
	again := editSource(t, h, docID, request)
	if first.Number != 2 || again != first {
		t.Fatalf("second attempt = %+v, want %+v", again, first)
	}
	if n := versionCount(t, e, docID); n != 2 {
		t.Fatalf("versions = %d, want 2", n)
	}
}

func TestEditSourceFailsCleanly(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	request := func(rs ...map[string]any) map[string]any {
		return map[string]any{"base_version_id": verID, "client_change_id": "chg_fail", "replacements": rs}
	}
	at := strings.Index(sourceFixtureHTML, "Middle.")
	status, body := postSourceEdits(t, e.h, docID, fixtureOwner, request(
		replaceAt(sourceFixtureHTML, "Try it.", "First.", 0),
		map[string]any{"start": at, "end": at + 7, "old_html": "Centre.", "new_html": "x"},
	))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	assertJSON(t, body, fmt.Sprintf(`{
	  "error": {
	    "code": "edit_failed",
	    "message": "replacement 1: old_html is not the HTML from start to end of the base version",
	    "details": { "index": 1, "reason": "old_html_mismatch", "current_version_id": %q }
	  }
	}`, verID))

	valid := replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0)
	tooMany := make([]map[string]any, 101)
	for i := range tooMany {
		tooMany[i] = valid
	}
	for _, body := range []any{
		map[string]any{},
		map[string]any{"client_change_id": "chg_fail", "replacements": []any{valid}},
		map[string]any{"base_version_id": verID, "replacements": []any{valid}},
		map[string]any{"base_version_id": verID, "client_change_id": strings.Repeat("x", 129), "replacements": []any{valid}},
		request(),
		request(tooMany...),
		map[string]any{"base_version_id": verID, "client_change_id": "chg_fail", "replacements": "Middle."},
	} {
		if status, out := postSourceEdits(t, e.h, docID, fixtureOwner, body); status != http.StatusBadRequest {
			t.Fatalf("body %v: status = %d; body=%s", body, status, out)
		}
	}

	// A base from another document is not found.
	status, body = postSourceEdits(t, e.h, docID, fixtureOwner, map[string]any{
		"base_version_id": e.ver.ID, "client_change_id": "chg_fail", "replacements": []any{valid},
	})
	if status != http.StatusNotFound {
		t.Fatalf("base of another document: status = %d; body=%s", status, body)
	}
	if n := versionCount(t, e, docID); n != 1 {
		t.Fatalf("versions = %d, want 1", n)
	}
}

func TestEditSourceNeedsEditorRole(t *testing.T) {
	e := newTestEnv(t)
	for _, p := range []auth.Principal{fixtureViewer, fixtureCommenter} {
		status, body := postSourceEdits(t, e.h, e.doc.ID, p, map[string]any{
			"base_version_id":  e.ver.ID,
			"client_change_id": "chg_role",
			"replacements":     []map[string]any{{"start": 12, "end": 19, "old_html": "fixture", "new_html": "changed"}},
		})
		if status != http.StatusForbidden {
			t.Fatalf("%s: status = %d; body=%s", p.ID, status, body)
		}
	}
}
