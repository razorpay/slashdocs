package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/textedit"
)

type documentChanges struct {
	VersionID     string                 `json:"version_id"`
	FromVersionID string                 `json:"from_version_id"`
	Replacements  []textedit.Replacement `json:"replacements"`
	Live          bool                   `json:"live"`
	Authors       []auth.Principal       `json:"authors"`
}

func getChanges(t *testing.T, e *testEnv, docID, from string, p auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/changes?from="+from, "", map[string]string{
		"X-Test-Principal": principalHeader(p),
	})
}

// changesFrom gets the changes of the document since the version from, as
// the viewer.
func changesFrom(t *testing.T, e *testEnv, docID, from string) documentChanges {
	t.Helper()
	rr := getChanges(t, e, docID, from, fixtureViewer)
	assertStatus(t, rr, http.StatusOK)
	var out documentChanges
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

type pushed struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	BaseVersionID string `json:"base_version_id"`
	Rebased       bool   `json:"rebased"`
}

// push uploads html as a version made from base, and returns the response.
func push(t *testing.T, e *testEnv, docID, base, html string, p auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := multipartBody(t, map[string]string{"base_version_id": base}, "file", "doc.html", html)
	return doRaw(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/versions", body, map[string]string{
		"Content-Type":     contentType,
		"X-Test-Principal": principalHeader(p),
	})
}

func pushedVersion(t *testing.T, rr *httptest.ResponseRecorder) pushed {
	t.Helper()
	assertStatus(t, rr, http.StatusCreated)
	var out pushed
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// names lists the ids of the principals.
func names(ps []auth.Principal) string {
	ids := make([]string, len(ps))
	for i, p := range ps {
		ids[i] = p.ID
	}
	return strings.Join(ids, ",")
}

func TestDocumentChangesGiveTheReplacementsSinceAVersion(t *testing.T) {
	e := newTestEnv(t)
	const html = "<html><body>fixture</body></html>"

	// At the newest version, nothing changed. The lists are empty, not null.
	rr := getChanges(t, e, e.doc.ID, e.ver.ID, fixtureViewer)
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), `{"version_id":"`+e.ver.ID+`","from_version_id":"`+e.ver.ID+`","replacements":[],"live":true,"authors":[]}`)

	// Two people type in the browser editor.
	var live sourceEdited
	for _, p := range []auth.Principal{fixtureOwner, fixtureEditor} {
		status, out := postSourceEdits(t, e.h, e.doc.ID, p, map[string]any{
			"base_version_id":  e.ver.ID,
			"client_change_id": "chg_" + p.ID,
			"replacements":     []map[string]any{{"start": 19, "end": 19, "old_html": "", "new_html": " " + p.Name + " é"}},
		})
		if status != http.StatusCreated {
			t.Fatalf("status = %d; body=%s", status, out)
		}
		if err := json.Unmarshal(out, &live); err != nil {
			t.Fatal(err)
		}
	}
	got := changesFrom(t, e, e.doc.ID, e.ver.ID)
	if got.VersionID != live.ID || got.FromVersionID != e.ver.ID || !got.Live || names(got.Authors) != "editor_1,owner_1" {
		t.Fatalf("changes = %+v", got)
	}
	if got.Authors[0].Name != fixtureEditor.Name || got.Authors[0].Email != fixtureEditor.Email {
		t.Fatalf("author = %+v, want the name and email of the editor", got.Authors[0])
	}
	// The replacements turn the HTML of the version into the newest HTML.
	want := "<html><body>fixture Editor é Owner é</body></html>"
	if patched, err := textedit.Replace([]byte(html), []byte(html), got.Replacements); err != nil || string(patched) != want {
		t.Fatalf("replacements %+v give %q, %v; want %q", got.Replacements, patched, err, want)
	}

	// A push is not live, and so are the changes that include it.
	uploaded := pushedVersion(t, push(t, e, e.doc.ID, live.ID, strings.Replace(want, "fixture", "Fixture", 1), fixtureOwner))
	if got := changesFrom(t, e, e.doc.ID, e.ver.ID); got.VersionID != uploaded.ID || got.Live || names(got.Authors) != "owner_1,editor_1" {
		t.Fatalf("changes with a push = %+v", got)
	}
	if got := changesFrom(t, e, e.doc.ID, live.ID); got.Live || names(got.Authors) != "owner_1" || len(got.Replacements) != 1 ||
		got.Replacements[0] != (textedit.Replacement{Start: 12, End: 13, OldHTML: "f", NewHTML: "F"}) {
		t.Fatalf("changes of the push = %+v", got)
	}
}

func TestDocumentChangesNeedAVersionOfTheDocumentAndViewerRole(t *testing.T) {
	e := newTestEnv(t)
	_, other := e.createDocument("Other", "<p>Other</p>", fixtureViewer)
	for name, from := range map[string]string{"another document": other, "no version": "ver_none", "empty": ""} {
		if rr := getChanges(t, e, e.doc.ID, from, fixtureViewer); rr.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d; body=%s", name, rr.Code, rr.Body)
		}
	}
	// A principal without access gets what the other routes that read give.
	versions := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	rr := getChanges(t, e, e.doc.ID, e.ver.ID, fixtureStranger)
	if rr.Code != http.StatusForbidden || rr.Code != versions.Code || rr.Body.String() != versions.Body.String() {
		t.Fatalf("stranger: status = %d, body=%s; versions give %d, %s", rr.Code, rr.Body, versions.Code, versions.Body)
	}
}

func TestDocumentChangesHaveABudgetForEachPrincipal(t *testing.T) {
	e := newTestEnv(t)
	for i := range 600 {
		if rr := getChanges(t, e, e.doc.ID, e.ver.ID, fixtureViewer); rr.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d; body=%s", i, rr.Code, rr.Body)
		}
	}
	assertStatus(t, getChanges(t, e, e.doc.ID, e.ver.ID, fixtureViewer), http.StatusTooManyRequests)
	assertStatus(t, getChanges(t, e, e.doc.ID, e.ver.ID, fixtureEditor), http.StatusOK)
}

func TestPushOnAnEarlierVersionMovesOntoTheCurrentVersion(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	typed := editSource(t, e.h, docID, map[string]any{
		"base_version_id":  verID,
		"client_change_id": "chg_typed",
		"replacements":     []map[string]any{replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0)},
	})

	// The push changes the paragraph that the newer version changed.
	rr := push(t, e, docID, verID, strings.Replace(sourceFixtureHTML, "Middle.", "Mine.", 1), fixtureOwner)
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": {
	    "code": "version_conflict",
	    "message": "base_version_id is stale",
	    "details": { "current_version_id": "`+typed.ID+`" }
	  }
	}`)
	// A push that changes nothing has nothing to move.
	assertStatus(t, push(t, e, docID, verID, sourceFixtureHTML, fixtureOwner), http.StatusConflict)
	if n := versionCount(t, e, docID); n != 2 {
		t.Fatalf("versions = %d, want 2", n)
	}

	// The push changes other text, so it saves on the newer version.
	rr = push(t, e, docID, verID, strings.Replace(sourceFixtureHTML, "Café 😀", "Thé 😁", 1), fixtureOwner)
	out := pushedVersion(t, rr)
	if out.Number != 3 || !out.Rebased || out.BaseVersionID != typed.ID {
		t.Fatalf("response = %s", rr.Body)
	}
	if want := "Uploaded a new version. Changed “Café 😀” to “Thé 😁”"; jsonField(t, rr.Body.Bytes(), "change_summary") != want {
		t.Fatalf("response = %s, want the summary %q", rr.Body, want)
	}
	want := "<html><body>\n<h1>Thé 😁</h1>\n<p>Try it.</p>\n<p>Centre.</p>\n<p>Try it.</p>\n</body></html>"
	if got := versionHTML(t, e, docID, out.ID); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}

	// A push on the current version is not rebased.
	rr = push(t, e, docID, out.ID, "<p>All new</p>", fixtureOwner)
	if next := pushedVersion(t, rr); next.Rebased || next.BaseVersionID != out.ID {
		t.Fatalf("response = %s", rr.Body)
	}
}

func TestVersionsSayWhichTheBrowserEditorMade(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	typed := editSource(t, e.h, docID, map[string]any{
		"base_version_id":  verID,
		"client_change_id": "chg_typed",
		"replacements":     []map[string]any{replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0)},
	})
	pushedVersion(t, push(t, e, docID, typed.ID, "<p>All new</p>", fixtureOwner))

	headers := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/versions", "", headers)
	assertStatus(t, rr, http.StatusOK)
	var list struct {
		Items []struct {
			Live *bool `json:"live"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	for i, want := range []bool{false, true, false} {
		if len(list.Items) != 3 || list.Items[i].Live == nil || *list.Items[i].Live != want {
			t.Fatalf("version %d: live is not %v in %s", i+1, want, rr.Body)
		}
	}
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/versions/"+typed.ID, "", headers)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"live":true`) {
		t.Fatalf("version = %s, want live", rr.Body)
	}
}

// Each write that makes a version names it in the document event, so that a
// viewer who already has the version does nothing.
func TestVersionWritesAnnounceTheNewVersion(t *testing.T) {
	e := newTestEnv(t)
	const html = "<html><body>fixture</body></html>"
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reader, _ := openLiveStream(ctx, t, ts, e.doc.ID, "", fixtureViewer)
	next := func(write string, body []byte) string {
		t.Helper()
		id := jsonField(t, body, "id")
		got := readLiveEvent(t, reader)
		if got.name != repo.DocumentEventDocument || string(got.event.Data) != `{"version_id":"`+id+`"}` {
			t.Fatalf("%s: event %s with data %s, want a document event for %s", write, got.name, got.event.Data, id)
		}
		return id
	}

	status, body := postSourceEdits(t, e.h, e.doc.ID, fixtureEditor, map[string]any{
		"base_version_id":  e.ver.ID,
		"client_change_id": "chg_event",
		"replacements":     []map[string]any{replaceAt(html, "fixture", "typed", 0)},
	})
	if status != http.StatusCreated {
		t.Fatalf("source edit status = %d; body=%s", status, body)
	}
	typed := next("source edit", body)

	status, body = postEdits(t, e, e.doc.ID, fixtureEditor, map[string]any{"edits": []map[string]string{{"old_string": "typed", "new_string": "edited"}}})
	if status != http.StatusCreated {
		t.Fatalf("edit status = %d; body=%s", status, body)
	}
	edited := next("edit", body)

	rr := push(t, e, e.doc.ID, edited, "<p>Pushed</p>", fixtureEditor)
	assertStatus(t, rr, http.StatusCreated)
	next("push", rr.Body.Bytes())

	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/versions/"+typed+"/restore", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, rr, http.StatusCreated)
	next("restore", rr.Body.Bytes())
}
