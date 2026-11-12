package server_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/textedit"
)

func getChanges(t *testing.T, e *testEnv, docID, after string, p auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/changes?after="+after, "", map[string]string{
		"X-Test-Principal": principalHeader(p),
	})
}

// changesAfter gets the changes of the document after the seq, as the viewer.
func changesAfter(t *testing.T, e *testEnv, docID string, after int64) repo.DocumentChanges {
	t.Helper()
	rr := getChanges(t, e, docID, strconv.FormatInt(after, 10), fixtureViewer)
	assertStatus(t, rr, http.StatusOK)
	var out repo.DocumentChanges
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
	Seq           int64  `json:"seq"`
}

// push uploads html as a version made from base, and returns the response.
func push(t *testing.T, e *testEnv, docID, base, html string, p auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	return pushWith(t, e, docID, map[string]string{"base_version_id": base}, html, p)
}

// pushAt is push for a file that was made from the source of base at seq.
func pushAt(t *testing.T, e *testEnv, docID, base string, seq int64, html string, p auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	return pushWith(t, e, docID, map[string]string{"base_version_id": base, "base_seq": strconv.FormatInt(seq, 10)}, html, p)
}

func pushWith(t *testing.T, e *testEnv, docID string, fields map[string]string, html string, p auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := multipartBody(t, fields, "file", "doc.html", html)
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

// errorCode reads the code of an error response.
func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("response is not JSON: %v; body=%s", err, body)
	}
	return out.Error.Code
}

// patched applies the operations to source, in order.
func patched(t *testing.T, source string, ops []json.RawMessage) string {
	t.Helper()
	for _, raw := range ops {
		var op []textedit.Replacement
		if err := json.Unmarshal(raw, &op); err != nil {
			t.Fatal(err)
		}
		next, err := textedit.Patch([]byte(source), op)
		if err != nil {
			t.Fatalf("operation %s does not fit %q: %v", raw, source, err)
		}
		source = string(next)
	}
	return source
}

func TestDocumentChangesGiveTheOperationsAfterASeq(t *testing.T) {
	e := newTestEnv(t)

	// At the live seq, nothing changed. The lists are empty, not null.
	rr := getChanges(t, e, e.doc.ID, "1", fixtureViewer)
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{"seq":1,"version_id":%q,"ops":[],"typed":true,"authors":[],"sum":%d}`, e.ver.ID, crc32.ChecksumIEEE([]byte(fixtureHTML))))

	// Two people type in the browser editor, on the same source.
	var typed repo.OperationResult
	for _, p := range []auth.Principal{fixtureOwner, fixtureEditor} {
		typed = typeOp(t, e, e.doc.ID, p, 1, "op_"+p.ID, map[string]any{"start": 19, "end": 19, "old_html": "", "new_html": " " + p.Name + " é"})
	}
	got := changesAfter(t, e, e.doc.ID, 1)
	if got.Seq != 3 || got.VersionID != typed.VersionID || !got.Typed || names(got.Authors) != "editor_1,owner_1" || len(got.Ops) != 2 {
		t.Fatalf("changes = %+v", got)
	}
	if got.Authors[0].Name != fixtureEditor.Name || got.Authors[0].Email != fixtureEditor.Email {
		t.Fatalf("author = %+v, want the name and email of the editor", got.Authors[0])
	}
	// The operations, in order, turn the source at the seq into the live
	// source, whose sum the answer has.
	want := "<html><body>fixture Editor é Owner é</body></html>"
	if live := patched(t, fixtureHTML, got.Ops); live != want || got.Sum != crc32.ChecksumIEEE([]byte(want)) || got.Sum != typed.Sum {
		t.Fatalf("operations %s give %q with sum %d; want %q", got.Ops, live, got.Sum, want)
	}
	// After the first operation, only the editor wrote.
	if got := changesAfter(t, e, e.doc.ID, 2); !got.Typed || names(got.Authors) != "editor_1" || len(got.Ops) != 1 {
		t.Fatalf("changes after 2 = %+v", got)
	}
	if got := changesAfter(t, e, e.doc.ID, 3); len(got.Ops) != 0 || len(got.Authors) != 0 {
		t.Fatalf("changes after the live seq = %+v, want none", got)
	}

	// A push is not typed, and so are the changes that include it. A page
	// gets a small push as an operation, and patches it in place.
	uploaded := pushedVersion(t, pushAt(t, e, e.doc.ID, typed.VersionID, 3, strings.Replace(want, "fixture", "Fixture", 1), fixtureOwner))
	if got := changesAfter(t, e, e.doc.ID, 1); got.Seq != 4 || got.VersionID != uploaded.ID || got.Typed || names(got.Authors) != "owner_1,editor_1" {
		t.Fatalf("changes with a push = %+v", got)
	}
	got = changesAfter(t, e, e.doc.ID, 3)
	if got.Typed || names(got.Authors) != "owner_1" || len(got.Ops) != 1 || patched(t, want, got.Ops) != strings.Replace(want, "fixture", "Fixture", 1) {
		t.Fatalf("changes of the push = %+v with %s", got, got.Ops)
	}
}

// The log does not hold a very large change. A page that is behind it loads
// the document again.
func TestDocumentChangesAreStaleAfterAVeryLargePush(t *testing.T) {
	e := newTestEnv(t)
	large := "<html><body>" + strings.Repeat("large ", 200_000) + "</body></html>"
	uploaded := pushedVersion(t, push(t, e, e.doc.ID, e.ver.ID, large, fixtureOwner))
	rr := getChanges(t, e, e.doc.ID, "1", fixtureViewer)
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{"error": {"code": "stale", "message": "The document changed too much since that seq. Get the document again."}}`)
	if got := changesAfter(t, e, e.doc.ID, 2); got.VersionID != uploaded.ID || len(got.Ops) != 0 {
		t.Fatalf("changes after the push = %+v, want none", got)
	}
	// An operation on the source before the push is stale too, and one on
	// the pushed source applies.
	status, body := postOp(t, e.h, e.doc.ID, fixtureEditor, map[string]any{"base_seq": 1, "client_op_id": "op_behind", "replacements": []any{replaceAt(fixtureHTML, "fixture", "typed", 0)}})
	if status != http.StatusConflict || errorCode(t, body) != "stale" {
		t.Fatalf("operation before the push: status = %d; body=%s", status, body)
	}
	typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_after", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "A "})
}

func TestDocumentChangesNeedASeqOfTheDocumentAndViewerRole(t *testing.T) {
	e := newTestEnv(t)
	// A seq after the live document.
	for _, after := range []string{"2", "-1"} {
		rr := getChanges(t, e, e.doc.ID, after, fixtureViewer)
		assertStatus(t, rr, http.StatusUnprocessableEntity)
		assertJSON(t, rr.Body.Bytes(), `{"error": {"code": "no_such_seq", "message": "after is not a seq of the document"}}`)
	}
	// A seq from before the log.
	assertStatus(t, getChanges(t, e, e.doc.ID, "0", fixtureViewer), http.StatusConflict)
	for _, after := range []string{"", "one", e.ver.ID} {
		assertStatus(t, getChanges(t, e, e.doc.ID, after, fixtureViewer), http.StatusBadRequest)
	}
	// A principal without access gets what the other routes that read give.
	versions := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	rr := getChanges(t, e, e.doc.ID, "1", fixtureStranger)
	if rr.Code != http.StatusForbidden || rr.Code != versions.Code || rr.Body.String() != versions.Body.String() {
		t.Fatalf("stranger: status = %d, body=%s; versions give %d, %s", rr.Code, rr.Body, versions.Code, versions.Body)
	}
}

func TestDocumentChangesHaveABudgetForEachPrincipal(t *testing.T) {
	e := newTestEnv(t)
	// A request that fails counts too.
	for i := range 1200 {
		if rr := getChanges(t, e, e.doc.ID, "", fixtureViewer); rr.Code != http.StatusBadRequest {
			t.Fatalf("request %d: status = %d; body=%s", i, rr.Code, rr.Body)
		}
	}
	assertStatus(t, getChanges(t, e, e.doc.ID, "1", fixtureViewer), http.StatusTooManyRequests)
	assertStatus(t, getChanges(t, e, e.doc.ID, "1", fixtureEditor), http.StatusOK)
	// The source at a seq costs as much, and is in the same budget.
	source := func(p auth.Principal) *httptest.ResponseRecorder {
		t.Helper()
		return do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions/"+e.ver.ID+"/html?seq=1", "", map[string]string{"X-Test-Principal": principalHeader(p)})
	}
	assertStatus(t, source(fixtureViewer), http.StatusTooManyRequests)
	assertStatus(t, source(fixtureEditor), http.StatusOK)
}

// A push while people type moves over their text and seals a version. The
// next operation opens a new version.
func TestPushDuringTypingMergesAndSeals(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureEditor, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	typed := typeOp(t, e, docID, fixtureEditor, 1, "op_typed", replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0))

	// The agent made its file from the first version, and changed other text.
	rr := push(t, e, docID, verID, strings.Replace(sourceFixtureHTML, "Café 😀", "Thé 😁", 1), fixtureOwner)
	out := pushedVersion(t, rr)
	if out.Number != 3 || !out.Rebased || out.BaseVersionID != typed.VersionID || out.Seq != 3 {
		t.Fatalf("response = %s, want version 3 at seq 3, rebased, on the typed version", rr.Body)
	}
	if want := "Changed “Café 😀” to “Thé 😁”"; jsonField(t, rr.Body.Bytes(), "change_summary") != want {
		t.Fatalf("response = %s, want the summary %q", rr.Body, want)
	}
	want := "<html><body>\n<h1>Thé 😁</h1>\n<p>Try it.</p>\n<p>Centre.</p>\n<p>Try it.</p>\n</body></html>"
	if got := versionHTML(t, e, docID, out.ID); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
	versions := listedVersions(t, e, docID)
	if len(versions) != 3 || versions[1].Open || versions[2].Open || versions[2].SHA256 != jsonField(t, rr.Body.Bytes(), "sha256") {
		t.Fatalf("versions = %+v, want three sealed versions", versions)
	}
	if names(versions[1].Authors) != "editor_1" || names(versions[2].Authors) != "owner_1" {
		t.Fatalf("authors = %+v and %+v, want the editor and then the owner", versions[1].Authors, versions[2].Authors)
	}
	if got, want := versionHTML(t, e, docID, typed.VersionID), strings.Replace(sourceFixtureHTML, "Middle.", "Centre.", 1); got != want {
		t.Fatalf("html of the typed version = %q, want %q", got, want)
	}

	next := typeOp(t, e, docID, fixtureEditor, 3, "op_next", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "<p>Top</p>"})
	if next.Seq != 4 || len(next.Others) != 0 || next.VersionID == out.ID {
		t.Fatalf("next = %+v, want seq 4 in a new version", next)
	}
	// The editor types on after the push: History shows one row for their
	// sitting, after the row of the push.
	if versions := listedVersions(t, e, docID); len(versions) != 3 || versions[1].ID != out.ID || versions[2].ID != next.VersionID || !versions[2].Open {
		t.Fatalf("versions = %+v, want the first, the push, and the open sitting", versions)
	}
}

// A push that changes text which people changed after its base is refused,
// and their text stays. The agent gets the document and makes its change
// again.
func TestPushThatTouchesTextOfOtherPeopleIsAConflict(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	typed := typeOp(t, e, docID, fixtureOwner, 1, "op_typed", replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0))
	// The answer names the sentence of the text of the push that the other
	// person changed.
	for name, tc := range map[string]struct{ html, text string }{
		"the same word":             {strings.Replace(sourceFixtureHTML, "Middle.", "Mine.", 1), "Middle."},
		"the paragraph of the word": {strings.Replace(sourceFixtureHTML, "<p>Middle.</p>\n", "", 1), "Middle."},
	} {
		rr := push(t, e, docID, verID, tc.html, fixtureOwner)
		assertStatus(t, rr, http.StatusConflict)
		assertJSON(t, rr.Body.Bytes(), `{
		  "error": {
		    "code": "version_conflict",
		    "message": "Other people changed the same text, and their text stays. Get the document again and make the change again.",
		    "details": { "current_version_id": "`+typed.VersionID+`", "seq": 2, "text": "`+tc.text+`" }
		  }
		}`)
		// The push saved nothing, and sealed nothing.
		if versions := listedVersions(t, e, docID); len(versions) != 2 || !versions[1].Open {
			t.Fatalf("%s: versions = %+v, want the typed one, still open", name, versions)
		}
	}
	if got, want := sourceAt(t, e, docID, typed.VersionID, 2), strings.Replace(sourceFixtureHTML, "Middle.", "Centre.", 1); got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}

	// The agent pulls the open version, at its seq, and pushes on that.
	live := sourceAt(t, e, docID, typed.VersionID, 2)
	typeOp(t, e, docID, fixtureOwner, 2, "op_more", replaceAt(live, "Café 😀", "Thé 😁", 0))
	// A file from the open version needs the seq that it was made from.
	rr := push(t, e, docID, typed.VersionID, strings.Replace(live, "Centre.", "Mine.", 1), fixtureOwner)
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{"error": {"code": "stale", "message": "People are editing this document, and the push did not send base_seq, so the server does not know which state of the document it changes. Send the seq of your read as base_seq. With the slashdocs CLI, update it, then pull the document and push again."}}`)
	rr = pushAt(t, e, docID, typed.VersionID, 2, strings.Replace(live, "Centre.", "Mine.", 1), fixtureOwner)
	out := pushedVersion(t, rr)
	if !out.Rebased || out.BaseVersionID != typed.VersionID || out.Seq != 4 {
		t.Fatalf("response = %s, want rebased on the typed version, at seq 4", rr.Body)
	}
	want := "<html><body>\n<h1>Thé 😁</h1>\n<p>Try it.</p>\n<p>Mine.</p>\n<p>Try it.</p>\n</body></html>"
	if got := versionHTML(t, e, docID, out.ID); got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
	// The base of a sealed version is its content, whatever seq the caller
	// names.
	assertStatus(t, pushAt(t, e, docID, out.ID, 9, want+"<p>More</p>", fixtureOwner), http.StatusCreated)
}

// A push that rewrites a sentence in which a person typed is refused, also
// when the person typed between two words that the old and the new sentence
// have in common. A push that changes other words of the paragraph merges.
func TestPushThatRewritesTheSentenceOfAPersonIsAConflict(t *testing.T) {
	e := newTestEnv(t)
	const html = "<html><body><p>Omega paragraph sits here at the very bottom of the document. It has a second sentence.</p></body></html>"
	docID, verID := e.createDocument("Omega", html, fixtureOwner)
	typed := typeOp(t, e, docID, fixtureOwner, 1, "op_human", replaceAt(html, "the document.", "HUMANCHANGE the document.", 0))
	rewritten := strings.Replace(html, "Omega paragraph sits here at the very bottom of the document.", "Omega is now a short line from the agent.", 1)
	rr := pushAt(t, e, docID, verID, 1, rewritten, fixtureOwner)
	assertStatus(t, rr, http.StatusConflict)
	if !strings.Contains(rr.Body.String(), `"code":"version_conflict"`) {
		t.Fatalf("response = %s, want version_conflict", rr.Body)
	}
	out := pushedVersion(t, pushAt(t, e, docID, verID, 1, strings.Replace(html, "second sentence", "short second sentence", 1), fixtureOwner))
	want := "<html><body><p>Omega paragraph sits here at the very bottom of HUMANCHANGE the document. It has a short second sentence.</p></body></html>"
	if got := versionHTML(t, e, docID, out.ID); !out.Rebased || got != want {
		t.Fatalf("push on %s = %q, rebased %v; want %q", typed.VersionID, got, out.Rebased, want)
	}
}

// A push with nothing after its base saves the file as it is.
func TestPushOnTheLiveDocumentGivesTheUploadedBytes(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	for _, html := range []string{
		"<p>All new</p>",
		"<html><body>\n<h1>Café \x00</h1><p>Try it.</p>\r\n<p>Try it.</p></body></html>\n",
	} {
		rr := push(t, e, docID, verID, html, fixtureOwner)
		out := pushedVersion(t, rr)
		if out.Rebased || out.BaseVersionID != verID {
			t.Fatalf("response = %s, want not rebased, on %s", rr.Body, verID)
		}
		if got := versionHTML(t, e, docID, out.ID); got != html {
			t.Fatalf("html = %q, want %q", got, html)
		}
		verID = out.ID
	}
	// The same holds on the open version, at its live seq.
	typed := typeOp(t, e, docID, fixtureOwner, 3, "op_typed", map[string]any{"start": 0, "end": 0, "old_html": "", "new_html": "<!doctype html>"})
	rr := pushAt(t, e, docID, typed.VersionID, typed.Seq, "<p>Exact</p>\r\n", fixtureOwner)
	if out := pushedVersion(t, rr); out.Rebased || versionHTML(t, e, docID, out.ID) != "<p>Exact</p>\r\n" {
		t.Fatalf("response = %s, want the uploaded bytes, not rebased", rr.Body)
	}
}

// The live document is always valid UTF-8.
func TestUploadsMustBeValidUTF8(t *testing.T) {
	e := newTestEnv(t)
	rr := push(t, e, e.doc.ID, e.ver.ID, "<p>Caf\xe9</p>", fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
	assertJSON(t, rr.Body.Bytes(), `{"error": {"code": "bad_request", "message": "the HTML file must be valid UTF-8"}}`)
	body, contentType := multipartBody(t, map[string]string{"title": "Latin"}, "file", "doc.html", "<p>Caf\xe9</p>")
	rr = doRaw(t, e.h, http.MethodPost, "/v1/documents", body, map[string]string{"Content-Type": contentType, "X-Test-Principal": principalHeader(fixtureOwner)})
	assertStatus(t, rr, http.StatusBadRequest)

	// A document from before this rule takes no operation, and a push
	// makes it valid.
	old, ver, err := e.store.CreateDocument(context.Background(), fixtureOwner, "Old", "", []byte("<p>Caf\xe9</p>"))
	if err != nil {
		t.Fatal(err)
	}
	status, raw := postOp(t, e.h, old.ID, fixtureOwner, map[string]any{"base_seq": 1, "client_op_id": "op_1", "replacements": []any{map[string]any{"start": 0, "end": 0, "old_html": "", "new_html": "x"}}})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("operation on a document that is not UTF-8: status = %d; body=%s", status, raw)
	}
	assertJSON(t, raw, `{"error": {"code": "edit_failed", "message": "the HTML of the document is not valid UTF-8"}}`)
	pushedVersion(t, push(t, e, old.ID, ver.ID, "<p>Café</p>", fixtureOwner))
	typeOp(t, e, old.ID, fixtureOwner, 2, "op_2", map[string]any{"start": 0, "end": 0, "old_html": "", "new_html": "x"})
}

// A push of the document as it is makes no version, and the answer names
// the current version. An author whose answer was lost can thus send a push
// again.
func TestPushOfTheDocumentAsItIsMakesNoVersion(t *testing.T) {
	e := newTestEnv(t)
	first := pushedVersion(t, push(t, e, e.doc.ID, e.ver.ID, "<p>New</p>", fixtureOwner))
	for _, base := range []string{first.ID, e.ver.ID} {
		rr := push(t, e, e.doc.ID, base, "<p>New</p>", fixtureOwner)
		assertStatus(t, rr, http.StatusOK)
		assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{"id": %q, "number": 2, "sha256": %q, "change_summary": %q, "base_version_id": %q, "rebased": false, "seq": 2, "unchanged": true}`,
			first.ID, jsonField(t, rr.Body.Bytes(), "sha256"), jsonField(t, rr.Body.Bytes(), "change_summary"), first.ID))
	}
	if versions := listedVersions(t, e, e.doc.ID); len(versions) != 2 || versions[1].SHA256 != jsonField(t, push(t, e, e.doc.ID, first.ID, "<p>New</p>", fixtureOwner).Body.Bytes(), "sha256") {
		t.Fatalf("versions = %+v, want two, and the sha256 of the second in the answer", versions)
	}
}

// An agent gets the document, a person types, and the agent pushes its file
// with no change. The answer names the base of the agent and not the live
// seq, for the CLI and for the MCP tool, which both use this answer: with
// the live seq as its base, the next push takes out the text of the person.
func TestAnUnchangedPushOfAnOlderFileAnswersItsBase(t *testing.T) {
	e := newTestEnv(t)
	typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", map[string]any{"start": 19, "end": 19, "old_html": "", "new_html": " typed"})
	rr := pushAt(t, e, e.doc.ID, e.ver.ID, 1, fixtureHTML, fixtureOwner)
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{"id": %q, "number": 1, "sha256": %q, "base_version_id": %q, "rebased": false, "seq": 1, "unchanged": true}`,
		e.ver.ID, fmt.Sprintf("%x", sha256.Sum256([]byte(fixtureHTML))), e.ver.ID))
	// The next push, on the base of that answer, merges with the typed text.
	merged := pushedVersion(t, pushAt(t, e, e.doc.ID, jsonField(t, rr.Body.Bytes(), "id"), 1, "<html><body>A fixture</body></html>", fixtureOwner))
	if got, want := versionHTML(t, e, e.doc.ID, merged.ID), "<html><body>A fixture typed</body></html>"; !merged.Rebased || got != want {
		t.Fatalf("pushed version = %q, rebased %v; want %q", got, merged.Rebased, want)
	}
}

// A base that the document does not have is not a conflict of text: the
// answer says what is wrong.
func TestPushNeedsABaseVersionOfTheDocument(t *testing.T) {
	e := newTestEnv(t)
	_, other := e.createDocument("Other", "<p>Other</p>", fixtureOwner)
	for _, base := range []string{"ver_none", other} {
		rr := push(t, e, e.doc.ID, base, "<p>New</p>", fixtureOwner)
		assertStatus(t, rr, http.StatusUnprocessableEntity)
		if errorCode(t, rr.Body.Bytes()) != "base_version_not_found" || !strings.Contains(rr.Body.String(), `"current_version_id":"`+e.ver.ID+`","seq":1`) {
			t.Fatalf("answer = %s, want base_version_not_found with the current version and its seq", rr.Body)
		}
	}
	assertStatus(t, push(t, e, e.doc.ID, "", "<p>New</p>", fixtureOwner), http.StatusBadRequest)
	assertStatus(t, pushWith(t, e, e.doc.ID, map[string]string{"base_version_id": e.ver.ID, "base_seq": "one"}, "<p>New</p>", fixtureOwner), http.StatusBadRequest)
	if versions := listedVersions(t, e, e.doc.ID); len(versions) != 1 {
		t.Fatalf("versions = %+v, want one", versions)
	}
}

// An approval is for a sealed version. A decision seals the open version,
// and the next operation opens a version with no approvals. A request for
// approval is for no content, and seals nothing.
func TestApprovalsSealTheOpenVersionAndTheNextOperationResetsThem(t *testing.T) {
	e := newTestEnv(t)
	typed := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", replaceAt(fixtureHTML, "fixture", "draft", 0))
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	if v := listedVersions(t, e, e.doc.ID)[1]; v.ID != typed.VersionID || !v.Open {
		t.Fatalf("version = %+v, want open after the request for approval", v)
	}
	// A decision that names no seq, as of the CLI, is refused while another
	// person types.
	rr := submitApproval(t, e, e.doc.ID, typed.VersionID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{"error": {"code": "version_superseded", "message": "People are editing this document. Decide when they are done."}}`)
	// When the editor stopped for 10 seconds, it seals the open version and
	// is for it, though the sitting is not over.
	quiet(t, e)
	rr = submitApproval(t, e, e.doc.ID, typed.VersionID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)
	if got := jsonField(t, rr.Body.Bytes(), "version_id"); got != typed.VersionID {
		t.Fatalf("decision = %s, want it on %s", rr.Body, typed.VersionID)
	}
	sealed := listedVersions(t, e, e.doc.ID)[1]
	if sealed.Open || sealed.SHA256 == "" {
		t.Fatalf("version = %+v, want sealed by the decision", sealed)
	}
	if list := listApprovals(t, e, e.doc.ID, "", fixtureViewer); list.Status != "approved" || list.VersionSHA256 != sealed.SHA256 {
		t.Fatalf("approvals = %+v, want approved on the sealed content", list)
	}

	// The next operation opens a version, which no one approved.
	next := typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_2", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "new "})
	if list := listApprovals(t, e, e.doc.ID, "", fixtureViewer); list.Status != "pending" || list.VersionID != next.VersionID || list.Items[0].Decision != nil {
		t.Fatalf("approvals = %+v, want pending on the open version", list)
	}
	// A decision on the version before is for text that is gone.
	quiet(t, e)
	assertStatus(t, submitApproval(t, e, e.doc.ID, typed.VersionID, "approved", fixtureViewer), http.StatusConflict)
	if v := listedVersions(t, e, e.doc.ID)[2]; !v.Open {
		t.Fatalf("version = %+v, want open: the refused decision sealed nothing", v)
	}
}

// quiet makes the operations of the document older than 10 seconds: the
// people who typed stopped.
func quiet(t *testing.T, e *testEnv) {
	t.Helper()
	if _, err := e.store.Pool().Exec(context.Background(), `UPDATE document_ops SET created_at = now() - interval '11 seconds' WHERE document_id = $1`, e.doc.ID); err != nil {
		t.Fatal(err)
	}
}

// A person types and takes the text out again: the sitting changed nothing
// so far. A decision on it seals it, and a sitting that ends on the text
// where it started is no version. The decision is then for the version
// before, which is the current one again.
func TestADecisionOnASittingThatChangedNothingIsForTheVersionBefore(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	typed := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "x"})
	typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_2", map[string]any{"start": 12, "end": 13, "old_html": "x", "new_html": ""})
	quiet(t, e)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/approvals",
		fmt.Sprintf(`{"version_id": %q, "decision": "approved", "seq": 3}`, typed.VersionID), map[string]string{
			"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureViewer),
		})
	assertStatus(t, rr, http.StatusCreated)
	if got := jsonField(t, rr.Body.Bytes(), "version_id"); got != e.ver.ID {
		t.Fatalf("decision = %s, want it on the version before, %s", rr.Body, e.ver.ID)
	}
	if list := listApprovals(t, e, e.doc.ID, "", fixtureViewer); list.Status != "approved" || list.VersionID != e.ver.ID {
		t.Fatalf("approvals = %+v, want approved on the version before", list)
	}
	if versions := listedVersions(t, e, e.doc.ID); len(versions) != 1 {
		t.Fatalf("versions = %+v, want only the first", versions)
	}
}

// The page of an approver sends the seq that it shows. An approval action
// on another seq is on text that the approver did not see.
func TestApprovalActionsNeedTheSeqThatTheApproverSaw(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	typed := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", replaceAt(fixtureHTML, "fixture", "draft", 0))
	decide := func(seq int64) *httptest.ResponseRecorder {
		t.Helper()
		return do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/approvals",
			fmt.Sprintf(`{"version_id": %q, "decision": "approved", "seq": %d}`, typed.VersionID, seq), map[string]string{
				"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureViewer),
			})
	}
	// The approver read the document at seq 2, and the editor typed on.
	typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_2", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "new "})
	// While the editor types, no decision is taken, also on the seq that the
	// approver sees: the next key of the editor would reset it.
	for _, seq := range []int64{2, 3} {
		rr := decide(seq)
		assertStatus(t, rr, http.StatusConflict)
		assertJSON(t, rr.Body.Bytes(), `{"error": {"code": "version_superseded", "message": "People are editing this document. Decide when they are done."}}`)
	}
	if list := listApprovals(t, e, e.doc.ID, "", fixtureViewer); list.Items[0].Decision != nil {
		t.Fatalf("approvals = %+v, want no decision", list)
	}
	// The editor stopped more than 10 seconds ago.
	quiet(t, e)
	rr := decide(2)
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{"error": {"code": "version_superseded", "message": "This document changed. Review the current document before deciding.", "details": {"current_version_id": %q, "seq": 3}}}`, typed.VersionID))
	if v := listedVersions(t, e, e.doc.ID)[1]; !v.Open {
		t.Fatalf("version = %+v, want open: the refused decision sealed nothing", v)
	}
	assertStatus(t, decide(3), http.StatusCreated)
	if v := listedVersions(t, e, e.doc.ID)[1]; v.Open {
		t.Fatalf("version = %+v, want sealed by the decision", v)
	}
}

// A version that opens, is sealed or is pushed sends a stored document event.
// The other operations of the browser editor are relayed and not stored, and
// a small one carries its replacements. The event of each operation says
// that its author typed, so that a page knows who types.
func TestDocumentEventsGiveTheSeqAndTheVersion(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reader, _ := openLiveStream(ctx, t, ts, e.doc.ID, "", fixtureViewer)
	next := func(what string, stored bool, want string) {
		t.Helper()
		got := readLiveEvent(t, reader)
		if got.name != repo.DocumentEventDocument || (got.id != "") != stored {
			t.Fatalf("%s: event %s with id %q and data %s, want a document event, stored: %v", what, got.name, got.id, got.event.Data, stored)
		}
		assertJSON(t, got.event.Data, want)
		if strings.Contains(want, `"typed":true`) && got.event.UpdatedBy.ID != fixtureEditor.ID {
			t.Fatalf("%s: updated_by = %+v, want the author", what, got.event.UpdatedBy)
		}
	}
	typed := func(seq int64, versionID string) string {
		return fmt.Sprintf(`{"seq":%d,"version_id":%q,"typed":true}`, seq, versionID)
	}
	// The event of a seal says so: History and the approvals changed.
	sealed := func(seq int64, versionID string) string {
		return fmt.Sprintf(`{"seq":%d,"version_id":%q,"sealed":true}`, seq, versionID)
	}

	opened := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", replaceAt(fixtureHTML, "fixture", "typed", 0))
	next("an operation that opens a version", true, typed(2, opened.VersionID))
	second := typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_2", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "re"})
	next("an operation in an open version", false, fmt.Sprintf(
		`{"seq":3,"version_id":%q,"prev_seq":2,"replacements":[{"start":12,"end":12,"old_html":"","new_html":"re"}],"typed":true,"sum":%d}`,
		opened.VersionID, second.Sum))
	// A large operation does not fit the relay, so the viewer asks for it.
	typeOp(t, e, e.doc.ID, fixtureEditor, 3, "op_3", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": strings.Repeat("long ", 2000)})
	next("a large operation", false, typed(4, opened.VersionID))
	typeOp(t, e, e.doc.ID, fixtureEditor, 4, "op_4", map[string]any{"start": 12, "end": 10012, "old_html": strings.Repeat("long ", 2000), "new_html": ""})
	next("a large deletion", false, typed(5, opened.VersionID))

	sealIdle(t, e, e.doc.ID)
	next("the end of editing", true, sealed(5, opened.VersionID))

	status, body := postEdits(t, e, e.doc.ID, fixtureEditor, map[string]any{"edits": []map[string]string{{"old_string": "typed", "new_string": "edited"}}})
	if status != http.StatusCreated {
		t.Fatalf("edit status = %d; body=%s", status, body)
	}
	edited := jsonField(t, body, "id")
	next("an edit", true, sealed(6, edited))

	typeOp(t, e, e.doc.ID, fixtureEditor, 6, "op_5", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "x"})
	next("an operation that opens a version", true, typed(7, listedVersions(t, e, e.doc.ID)[3].ID))
	rr := push(t, e, e.doc.ID, edited, "<p>Pushed</p>", fixtureEditor)
	assertStatus(t, rr, http.StatusConflict)
	rr = pushAt(t, e, e.doc.ID, listedVersions(t, e, e.doc.ID)[3].ID, 7, "<p>Pushed</p>", fixtureEditor)
	assertStatus(t, rr, http.StatusCreated)
	next("the seal before a push", true, sealed(7, listedVersions(t, e, e.doc.ID)[3].ID))
	next("a push", true, sealed(8, jsonField(t, rr.Body.Bytes(), "id")))

	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/versions/"+edited+"/restore", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, rr, http.StatusCreated)
	restored := jsonField(t, rr.Body.Bytes(), "id")
	// The event of a restore says so: the pages tell their readers.
	next("a restore", true, fmt.Sprintf(`{"seq":9,"version_id":%q,"sealed":true,"restored":true}`, restored))
	if got, want := versionHTML(t, e, e.doc.ID, restored), "<html><body>reedited</body></html>"; got != want {
		t.Fatalf("restored html = %q, want %q", got, want)
	}
}

// The render URL of a version renders the source at the seq of the answer.
func TestRenderTokenNamesTheSeqThatItsURLRenders(t *testing.T) {
	e := newTestEnv(t)
	typed := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", replaceAt(fixtureHTML, "fixture", "one", 0))
	token := func() (url string, seq int64, cookie string) {
		t.Helper()
		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/versions/"+typed.VersionID+"/render-token", "", map[string]string{
			"X-Test-Principal": principalHeader(fixtureViewer),
		})
		assertStatus(t, rr, http.StatusOK)
		var out struct {
			URL string `json:"url"`
			Seq int64  `json:"seq"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.URL, out.Seq, rr.Result().Cookies()[0].String()
	}
	url, seq, cookie := token()
	if want := "/v/" + e.doc.ID + "/" + typed.VersionID + "?seq=2"; seq != 2 || url != want {
		t.Fatalf("render token = %q at seq %d, want %q at seq 2", url, seq, want)
	}
	// The URL keeps its source when the version moves on.
	typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_2", map[string]any{"start": 12, "end": 15, "old_html": "one", "new_html": "two"})
	headers := map[string]string{"Cookie": cookie}
	rr := do(t, e.h, http.MethodGet, url, "", headers)
	assertStatus(t, rr, http.StatusOK)
	if body := rr.Body.String(); !strings.Contains(body, "&gt;one&lt;") || strings.Contains(body, "&gt;two&lt;") {
		t.Fatalf("render = %q, want the source at seq 2", body)
	}
	if _, seq, _ := token(); seq != 3 {
		t.Fatalf("seq = %d, want 3", seq)
	}
	// For a seq that the server does not have, the frame gets the version
	// as it is now. The app, whose seq is then behind, loads it again.
	rr = do(t, e.h, http.MethodGet, strings.Replace(url, "seq=2", "seq=9", 1), "", headers)
	assertStatus(t, rr, http.StatusOK)
	if body := rr.Body.String(); !strings.Contains(body, "&gt;two&lt;") {
		t.Fatalf("render = %q, want the live document", body)
	}
	if v := listedVersions(t, e, e.doc.ID)[1]; !v.Open {
		t.Fatalf("version = %+v, want open: a render seals nothing", v)
	}
}
