package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/textedit"
)

const (
	fixtureHTML       = "<html><body>fixture</body></html>"
	sourceFixtureHTML = "<html><body>\n<h1>Café 😀</h1>\n<p>Try it.</p>\n<p>Middle.</p>\n<p>Try it.</p>\n</body></html>"
)

func postOp(t *testing.T, h http.Handler, docID string, p auth.Principal, body any) (int, []byte) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rr := do(t, h, http.MethodPost, "/v1/documents/"+docID+"/ops", string(b), map[string]string{
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

// typeOp writes the replacements, made on the source at baseSeq, as an
// operation of the browser editor of p, and returns the answer.
func typeOp(t *testing.T, e *testEnv, docID string, p auth.Principal, baseSeq int64, opID string, rs ...map[string]any) repo.OperationResult {
	t.Helper()
	status, body := postOp(t, e.h, docID, p, map[string]any{"base_seq": baseSeq, "client_op_id": opID, "replacements": rs})
	if status != http.StatusOK {
		t.Fatalf("%s: status = %d; body=%s", opID, status, body)
	}
	var out repo.OperationResult
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func listedVersions(t *testing.T, e *testEnv, docID string) []repo.Version {
	t.Helper()
	versions, err := e.store.ListVersions(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	return versions
}

// sealIdle seals the open version of the document, as the background task
// does after 10 minutes with no operation.
func sealIdle(t *testing.T, e *testEnv, docID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := e.store.Pool().Exec(ctx, `UPDATE document_ops SET created_at = now() - interval '11 minutes' WHERE document_id = $1`, docID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.SealIdleVersions(ctx); err != nil {
		t.Fatal(err)
	}
}

// sourceAt reads the source of the version at seq.
func sourceAt(t *testing.T, e *testEnv, docID, versionID string, seq int64) string {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/versions/"+versionID+"/html?seq="+strconv.FormatInt(seq, 10), "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusOK)
	return rr.Body.String()
}

// names lists the ids of the principals.
func names(ps []auth.Principal) string {
	ids := make([]string, len(ps))
	for i, p := range ps {
		ids[i] = p.ID
	}
	return strings.Join(ids, ",")
}

// A burst of typing by two people is one version, which stays open.
func TestOperationsOfABurstMakeOneOpenVersion(t *testing.T) {
	e := newTestEnv(t)
	first := typeOp(t, e, e.doc.ID, fixtureOwner, 1, "op_owner", replaceAt(fixtureHTML, "fixture", "fixtures", 0))
	if first.Seq != 2 || first.VersionID == e.ver.ID || len(first.Others) != 0 {
		t.Fatalf("first = %+v, want seq 2 in a new version", first)
	}
	second := typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_editor", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "My "})
	if second.Seq != 3 || second.VersionID != first.VersionID || len(second.Others) != 0 {
		t.Fatalf("second = %+v, want seq 3 in the version of the first", second)
	}
	if got, want := sourceAt(t, e, e.doc.ID, first.VersionID, 3), "<html><body>My fixtures</body></html>"; got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}

	headers := map[string]string{"X-Test-Principal": principalHeader(fixtureViewer)}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions", "", headers)
	assertStatus(t, rr, http.StatusOK)
	var list struct {
		Items []repo.Version `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 2 || strings.Contains(rr.Body.String(), `"live"`) {
		t.Fatalf("versions = %s, want two and no live field", rr.Body)
	}
	created, typed := list.Items[0], list.Items[1]
	if created.Open || names(created.Authors) != "owner_1" || created.SHA256 == "" {
		t.Fatalf("first version = %+v, want sealed, by the owner", created)
	}
	if typed.ID != first.VersionID || typed.Number != 2 || !typed.Open || names(typed.Authors) != "owner_1,editor_1" || typed.SHA256 != "" {
		t.Fatalf("typed version = %+v, want open, by the owner and the editor", typed)
	}
	if typed.Authors[1].Name != fixtureEditor.Name || typed.Authors[1].Email != fixtureEditor.Email {
		t.Fatalf("author = %+v, want the name and email of the editor", typed.Authors[1])
	}

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions/"+typed.ID, "", headers)
	assertStatus(t, rr, http.StatusOK)
	var one repo.Version
	if err := json.Unmarshal(rr.Body.Bytes(), &one); err != nil || !one.Open || names(one.Authors) != "owner_1,editor_1" {
		t.Fatalf("version = %s, %v; want open, by the owner and the editor", rr.Body, err)
	}

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", headers)
	assertStatus(t, rr, http.StatusOK)
	var doc repo.Document
	if err := json.Unmarshal(rr.Body.Bytes(), &doc); err != nil || doc.Seq != 3 || doc.CurrentVersionID != typed.ID {
		t.Fatalf("document = %s, %v; want seq 3 at the typed version", rr.Body, err)
	}
}

func TestOperationReplacesByPosition(t *testing.T) {
	e := newTestEnv(t)
	docID, _ := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	// Only the second of the two equal labels changes, and a new paragraph
	// goes after it.
	end := strings.LastIndex(sourceFixtureHTML, "\n</body>")
	out := typeOp(t, e, docID, fixtureOwner, 1, "op_position",
		replaceAt(sourceFixtureHTML, "Try it.", "Run it.", 1),
		map[string]any{"start": end, "end": end, "old_html": "", "new_html": "\n<p>New <b>words</b></p>"},
	)
	want := "<html><body>\n<h1>Café 😀</h1>\n<p>Try it.</p>\n<p>Middle.</p>\n<p>Run it.</p>\n<p>New <b>words</b></p>\n</body></html>"
	if got := sourceAt(t, e, docID, out.VersionID, out.Seq); got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}
}

// Two people type in one word of the source at one seq. The browser sends
// the whole word, and both texts stay.
func TestTwoWritersInOneWordBothKeepTheirText(t *testing.T) {
	e := newTestEnv(t)
	first := typeOp(t, e, e.doc.ID, fixtureOwner, 1, "op_owner", replaceAt(fixtureHTML, "fixture", "fixtures", 0))
	status, raw := postOp(t, e.h, e.doc.ID, fixtureEditor, map[string]any{
		"base_seq": 1, "client_op_id": "op_editor", "replacements": []any{replaceAt(fixtureHTML, "fixture", "prefixture", 0)},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, raw)
	}
	// The second writer holds "prefixture", and learns of the "s" of the
	// first one from the answer: the operations of the other people, in
	// order, and the sum of the source after them.
	assertJSON(t, raw, fmt.Sprintf(`{"seq":3,"version_id":%q,"others":[[{"start":22,"end":22,"old_html":"","new_html":"s"}]],"sum":%d}`,
		first.VersionID, crc32.ChecksumIEEE([]byte("<html><body>prefixtures</body></html>"))))
	if got, want := sourceAt(t, e, e.doc.ID, first.VersionID, 3), "<html><body>prefixtures</body></html>"; got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}
	// An operation that did not merge names no other operations, with a list.
	if first.Others == nil || len(first.Others) != 0 || first.Sum != crc32.ChecksumIEEE([]byte("<html><body>fixtures</body></html>")) {
		t.Fatalf("first = %+v, want an empty list of others", first)
	}

	// Another operation lands before the retry of the second one. The retry
	// applies nothing and gets the same answer.
	typeOp(t, e, e.doc.ID, fixtureOwner, 3, "op_owner_2", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "A "})
	status, again := postOp(t, e.h, e.doc.ID, fixtureEditor, map[string]any{
		"base_seq": 1, "client_op_id": "op_editor", "replacements": []any{replaceAt(fixtureHTML, "fixture", "prefixture", 0)},
	})
	if status != http.StatusOK || string(again) != string(raw) {
		t.Fatalf("retry = %d, %s; want %s", status, again, raw)
	}
	if got, want := versionHTML(t, e, e.doc.ID, first.VersionID), "<html><body>A prefixtures</body></html>"; got != want {
		t.Fatalf("html = %q, want %q", got, want)
	}
}

// The summary of an operation holds at most 200 characters.
func TestOperationSummaryIsCut(t *testing.T) {
	e := newTestEnv(t)
	status, raw := postOp(t, e.h, e.doc.ID, fixtureOwner, map[string]any{
		"base_seq": 1, "client_op_id": "op_long", "summary": strings.Repeat("é", 300),
		"replacements": []any{replaceAt(fixtureHTML, "fixture", "fixtures", 0)},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, raw)
	}
	sealIdle(t, e, e.doc.ID)
	if got := listedVersions(t, e, e.doc.ID)[1].ChangeSummary; got != strings.Repeat("é", 200) {
		t.Fatalf("summary = %d characters, want 200", len([]rune(got)))
	}
}

// Two people replace the same word. Both words stay whole, and the word of
// the operation that arrives later comes first.
func TestTwoWritersWhoReplaceTheSameWordBothKeepTheirWord(t *testing.T) {
	e := newTestEnv(t)
	typeOp(t, e, e.doc.ID, fixtureOwner, 1, "op_owner", replaceAt(fixtureHTML, "fixture", "cow", 0))
	later := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_editor", replaceAt(fixtureHTML, "fixture", "dog", 0))
	// The later writer holds "dog", and gets the earlier word after it.
	want := textedit.Replacement{Start: 15, End: 15, NewHTML: "cow"}
	if len(later.Others) != 1 || len(later.Others[0]) != 1 || later.Others[0][0] != want {
		t.Fatalf("later = %+v, want the word of the other writer after its own", later)
	}
	if got, want := sourceAt(t, e, e.doc.ID, later.VersionID, later.Seq), "<html><body>dogcow</body></html>"; got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}
}

func TestOperationRebasesOntoAnAgentEdit(t *testing.T) {
	e := newTestEnv(t)
	docID, _ := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	// An agent changes the multi-byte heading before both replacements and
	// the paragraph between them.
	status, body := postEdits(t, e, docID, fixtureOwner, map[string]any{"edits": []map[string]string{
		{"old_string": "Café 😀", "new_string": "Crème brûlée 😀😀"},
		{"old_string": "Middle.", "new_string": "Between the two."},
	}})
	if status != http.StatusCreated {
		t.Fatalf("agent edit status = %d; body=%s", status, body)
	}
	out := typeOp(t, e, docID, fixtureOwner, 1, "op_rebase",
		replaceAt(sourceFixtureHTML, "Try it.", "First.", 0),
		replaceAt(sourceFixtureHTML, "Try it.", "Last.", 1),
	)
	if out.Seq != 3 || len(out.Others) != 1 || out.VersionID == jsonField(t, body, "id") {
		t.Fatalf("response = %+v, want seq 3, over one operation, in a new version", out)
	}
	want := "<html><body>\n<h1>Crème brûlée 😀😀</h1>\n<p>First.</p>\n<p>Between the two.</p>\n<p>Last.</p>\n</body></html>"
	if got := sourceAt(t, e, docID, out.VersionID, 3); got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}
}

// The source at an earlier seq stays readable while the version is open.
func TestVersionHTMLGivesTheSourceAtASeq(t *testing.T) {
	e := newTestEnv(t)
	first := typeOp(t, e, e.doc.ID, fixtureOwner, 1, "op_1", replaceAt(fixtureHTML, "fixture", "one", 0))
	typeOp(t, e, e.doc.ID, fixtureOwner, 2, "op_2", map[string]any{"start": 12, "end": 15, "old_html": "one", "new_html": "two"})
	for seq, want := range map[int64]string{2: "<html><body>one</body></html>", 3: "<html><body>two</body></html>"} {
		if got := sourceAt(t, e, e.doc.ID, first.VersionID, seq); got != want {
			t.Fatalf("source at %d = %q, want %q", seq, got, want)
		}
	}
	// The current version follows the live document from before it opened.
	for _, versionID := range []string{e.ver.ID, first.VersionID} {
		if got := sourceAt(t, e, e.doc.ID, versionID, 1); got != fixtureHTML {
			t.Fatalf("source of %s at 1 = %q, want %q", versionID, got, fixtureHTML)
		}
	}
	// A seq that the version cannot give is stale: a version before the
	// current one has only its content, and no seq is after the live one.
	for _, path := range []string{
		e.ver.ID + "/html?seq=2", first.VersionID + "/html?seq=4", first.VersionID + "/html?seq=two", first.VersionID + "/html?seq=-1",
	} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions/"+path, "", map[string]string{"X-Test-Principal": principalHeader(fixtureViewer)})
		assertStatus(t, rr, http.StatusConflict)
		assertJSON(t, rr.Body.Bytes(), `{"error": {"code": "stale", "message": "The document changed too much since that seq. Get the document again."}}`)
	}
}

// No read seals a version. A read of the open version gives the live
// document, and the header says at which seq.
func TestReadOfAnOpenVersionGivesTheLiveDocumentAndSealsNothing(t *testing.T) {
	e := newTestEnv(t)
	typed := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", replaceAt(fixtureHTML, "fixture", "typed", 0))
	read := func(versionID string) (string, string) {
		t.Helper()
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions/"+versionID+"/html", "", map[string]string{"X-Test-Principal": principalHeader(fixtureViewer)})
		assertStatus(t, rr, http.StatusOK)
		return rr.Body.String(), rr.Header().Get("X-Slashdocs-Seq")
	}
	if html, seq := read(typed.VersionID); html != "<html><body>typed</body></html>" || seq != "2" {
		t.Fatalf("open version = %q at seq %s, want the live document at 2", html, seq)
	}
	if html, seq := read(e.ver.ID); html != fixtureHTML || seq != "1" {
		t.Fatalf("first version = %q at seq %s, want its content at 1", html, seq)
	}
	typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_2", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "re"})
	if html, seq := read(typed.VersionID); html != "<html><body>retyped</body></html>" || seq != "3" {
		t.Fatalf("open version = %q at seq %s, want the live document at 3", html, seq)
	}
	// Comments, headings and the print page read the live document too.
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/headings", "", map[string]string{"X-Test-Principal": principalHeader(fixtureViewer)})
	assertStatus(t, rr, http.StatusOK)
	if versions := listedVersions(t, e, e.doc.ID); len(versions) != 2 || !versions[1].Open {
		t.Fatalf("versions = %+v, want the typed one still open", versions)
	}
}

// A sitting ends only when it is idle: no request of a page seals the open
// version. The next operation after the seal opens a new version.
func TestOnlyTheIdleTimeEndsASitting(t *testing.T) {
	e := newTestEnv(t)
	typed := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", replaceAt(fixtureHTML, "fixture", "typed", 0))
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/checkpoint", "", map[string]string{"X-Test-Principal": principalHeader(fixtureEditor)})
	assertStatus(t, rr, http.StatusNotFound)
	if v := listedVersions(t, e, e.doc.ID)[1]; !v.Open {
		t.Fatalf("version = %+v, want open", v)
	}
	sealIdle(t, e, e.doc.ID)
	sealed := listedVersions(t, e, e.doc.ID)[1]
	if sealed.Open || sealed.SHA256 == "" || sealed.ChangeSummary != "Changed “fixture” to “typed”" {
		t.Fatalf("version = %+v, want sealed with a summary of the change", sealed)
	}
	next := typeOp(t, e, e.doc.ID, fixtureEditor, 2, "op_2", map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "re"})
	if next.Seq != 3 || next.VersionID == typed.VersionID {
		t.Fatalf("next = %+v, want seq 3 in a new version", next)
	}
	versions := listedVersions(t, e, e.doc.ID)
	if len(versions) != 3 || !versions[2].Open || versions[2].Number != 3 {
		t.Fatalf("versions = %+v, want a third, open", versions)
	}
	// The sealed version keeps its content.
	if got, want := versionHTML(t, e, e.doc.ID, typed.VersionID), "<html><body>typed</body></html>"; got != want {
		t.Fatalf("html of the sealed version = %q, want %q", got, want)
	}
}

// An operation of a writer who is behind moves over the exact operations
// of the other writer, and not over a guess from a diff.
func TestOperationLandsInTheItemOfItsWriter(t *testing.T) {
	e := newTestEnv(t)
	const list = "<ul><li>buy milk</li><li>buy milk</li></ul>"
	docID, _ := e.createDocument("List", list, fixtureOwner)
	// One writer deletes the first of two equal items, and the other, on
	// the same source, replaces a word in the second.
	typeOp(t, e, docID, fixtureOwner, 1, "op_delete", map[string]any{"start": 4, "end": 21, "old_html": "<li>buy milk</li>", "new_html": ""})
	out := typeOp(t, e, docID, fixtureOwner, 1, "op_word", replaceAt(list, "milk", "bread", 1))
	if got, want := sourceAt(t, e, docID, out.VersionID, out.Seq), "<ul><li>buy bread</li></ul>"; got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}
	// The second writer holds both items, and gets the deletion of the first.
	held := strings.Replace(list, "milk</li></ul>", "bread</li></ul>", 1)
	if got, err := textedit.Patch([]byte(held), out.Others[0]); err != nil || string(got) != "<ul><li>buy bread</li></ul>" {
		t.Fatalf("others %+v give %q, %v", out.Others, got, err)
	}
}

// The summaries that the operations of a version carry are its change
// summary, each one time.
func TestSealedVersionHasTheSummariesOfItsOperations(t *testing.T) {
	e := newTestEnv(t)
	var out repo.OperationResult
	for i, summary := range []string{"Renamed the fixture", "", "Fixed a typo", "Renamed the fixture"} {
		status, body := postOp(t, e.h, e.doc.ID, fixtureEditor, map[string]any{
			"base_seq": i + 1, "client_op_id": "op_" + strconv.Itoa(i), "summary": summary,
			"replacements": []any{map[string]any{"start": 12, "end": 12, "old_html": "", "new_html": "x"}},
		})
		if status != http.StatusOK {
			t.Fatalf("status = %d; body=%s", status, body)
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
	}
	sealIdle(t, e, e.doc.ID)
	if got, want := listedVersions(t, e, e.doc.ID)[1].ChangeSummary, "Renamed the fixture\nFixed a typo"; got != want {
		t.Fatalf("change_summary = %q, want %q", got, want)
	}
}

func TestOperationFailsCleanly(t *testing.T) {
	e := newTestEnv(t)
	docID, _ := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	request := func(baseSeq int, rs ...map[string]any) map[string]any {
		return map[string]any{"base_seq": baseSeq, "client_op_id": "op_fail", "replacements": rs}
	}
	at := strings.Index(sourceFixtureHTML, "Middle.")
	status, body := postOp(t, e.h, docID, fixtureOwner, request(1,
		replaceAt(sourceFixtureHTML, "Try it.", "First.", 0),
		map[string]any{"start": at, "end": at + 7, "old_html": "Centre.", "new_html": "x"},
	))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	assertJSON(t, body, `{
	  "error": {
	    "code": "edit_failed",
	    "message": "replacement 1: old_html is not the HTML from start to end of the source at the base seq",
	    "details": { "index": 1, "reason": "old_html_mismatch" }
	  }
	}`)

	valid := replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0)
	// A base after the live document is not a seq of the document.
	status, body = postOp(t, e.h, docID, fixtureOwner, request(2, valid))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("base after the live seq: status = %d; body=%s", status, body)
	}
	assertJSON(t, body, `{"error": {"code": "edit_failed", "message": "base_seq is after the live document"}}`)
	// The log does not reach a base from before the document.
	status, body = postOp(t, e.h, docID, fixtureOwner, request(0, valid))
	if status != http.StatusConflict {
		t.Fatalf("base before the log: status = %d; body=%s", status, body)
	}
	assertJSON(t, body, `{"error": {"code": "stale", "message": "The document changed too much since that seq. Get the document again."}}`)
	// The log holds JSON, which does not take the NUL character.
	status, body = postOp(t, e.h, docID, fixtureOwner, request(1, replaceAt(sourceFixtureHTML, "Middle.", "a\x00b", 0)))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("a NUL character: status = %d; body=%s", status, body)
	}
	// A fault of a client must not spoil the document: a tag that does not
	// end is not taken.
	status, body = postOp(t, e.h, docID, fixtureOwner, request(1, replaceAt(sourceFixtureHTML, "Middle.", "Mid</p", 0)))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("a tag that does not end: status = %d; body=%s", status, body)
	}
	assertJSON(t, body, `{
	  "error": {
	    "code": "edit_failed",
	    "message": "the replacements would put text into a tag of the live document, or leave a tag that does not end",
	    "details": { "index": 0, "reason": "breaks_tags" }
	  }
	}`)

	tooMany := make([]map[string]any, textedit.MaxEdits+1)
	for i := range tooMany {
		tooMany[i] = valid
	}
	for _, body := range []any{
		map[string]any{},
		map[string]any{"client_op_id": "op_fail", "replacements": []any{valid}},
		map[string]any{"base_seq": -1, "client_op_id": "op_fail", "replacements": []any{valid}},
		map[string]any{"base_seq": 1, "replacements": []any{valid}},
		map[string]any{"base_seq": 1, "client_op_id": strings.Repeat("x", 129), "replacements": []any{valid}},
		map[string]any{"base_seq": 1, "client_op_id": "op\x00fail", "replacements": []any{valid}},
		map[string]any{"base_seq": 1, "client_op_id": "op_fail", "summary": "a\x00b", "replacements": []any{valid}},
		request(1),
		request(1, tooMany...),
		map[string]any{"base_seq": 1, "client_op_id": "op_fail", "replacements": "Middle."},
	} {
		if status, out := postOp(t, e.h, docID, fixtureOwner, body); status != http.StatusBadRequest {
			t.Fatalf("body %v: status = %d; body=%s", body, status, out)
		}
	}
	if versions := listedVersions(t, e, docID); len(versions) != 1 || versions[0].Open {
		t.Fatalf("versions = %+v, want the first one only", versions)
	}
}

func TestOperationNeedsEditorRole(t *testing.T) {
	e := newTestEnv(t)
	for _, p := range []auth.Principal{fixtureViewer, fixtureCommenter, fixtureStranger} {
		status, body := postOp(t, e.h, e.doc.ID, p, map[string]any{
			"base_seq": 1, "client_op_id": "op_role", "replacements": []any{replaceAt(fixtureHTML, "fixture", "changed", 0)},
		})
		if status != http.StatusForbidden {
			t.Fatalf("%s: status = %d; body=%s", p.ID, status, body)
		}
	}
	if d, err := e.store.GetDocument(context.Background(), e.doc.ID); err != nil || d.Seq != 1 {
		t.Fatalf("document = %+v, %v; want seq 1", d, err)
	}
}

func TestOperationsHaveABudgetForEachPrincipal(t *testing.T) {
	e := newTestEnv(t)
	// A request that fails counts too.
	for i := range 1200 {
		if status, body := postOp(t, e.h, e.doc.ID, fixtureEditor, map[string]any{}); status != http.StatusBadRequest {
			t.Fatalf("request %d: status = %d; body=%s", i, status, body)
		}
	}
	if status, body := postOp(t, e.h, e.doc.ID, fixtureEditor, map[string]any{}); status != http.StatusTooManyRequests {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	if status, body := postOp(t, e.h, e.doc.ID, fixtureOwner, map[string]any{}); status != http.StatusBadRequest {
		t.Fatalf("another principal: status = %d; body=%s", status, body)
	}
}

// The others of an answer turn the source that the sender holds into the
// source at the seq of the answer.
func TestOthersOfARebasedOperationGiveTheLiveSource(t *testing.T) {
	e := newTestEnv(t)
	docID, _ := e.createDocument("Source", sourceFixtureHTML, fixtureOwner)
	typeOp(t, e, docID, fixtureOwner, 1, "op_1", replaceAt(sourceFixtureHTML, "Café 😀", "Thé 😁", 0))
	out := typeOp(t, e, docID, fixtureOwner, 1, "op_2", replaceAt(sourceFixtureHTML, "Middle.", "Centre.", 0))
	held := strings.Replace(sourceFixtureHTML, "Middle.", "Centre.", 1)
	got, err := textedit.Patch([]byte(held), out.Others[0])
	if want := sourceAt(t, e, docID, out.VersionID, out.Seq); err != nil || string(got) != want || !slices.Contains(strings.Fields(want), "😁</h1>") {
		t.Fatalf("others %+v give %q, %v; want %q", out.Others, got, err, want)
	}
}

// The answer to an operation is lost, and the tab sends the same body after
// the log lost the replacements of the operation. The answer says that the
// document has the operation, so the browser does not put its text in a
// second time.
func TestARepeatOfAnOldOperationSaysThatTheDocumentHasIt(t *testing.T) {
	e := newTestEnv(t)
	body := map[string]any{"base_seq": 1, "client_op_id": "op_1", "replacements": []any{replaceAt(fixtureHTML, "fixture", "typed", 0)}}
	if status, raw := postOp(t, e.h, e.doc.ID, fixtureEditor, body); status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, raw)
	}
	if _, err := e.store.Pool().Exec(context.Background(), `UPDATE document_ops SET replacements = NULL WHERE document_id = $1`, e.doc.ID); err != nil {
		t.Fatal(err)
	}
	status, raw := postOp(t, e.h, e.doc.ID, fixtureEditor, body)
	if status != http.StatusConflict {
		t.Fatalf("status = %d; body=%s", status, raw)
	}
	assertJSON(t, raw, `{"error": {"code": "stale", "message": "The document changed too much since that seq. Get the document again.", "details": {"applied": true}}}`)
	// An operation that the document does not have is only stale.
	body["client_op_id"] = "op_2"
	if status, raw = postOp(t, e.h, e.doc.ID, fixtureEditor, body); status != http.StatusConflict || strings.Contains(string(raw), "applied") {
		t.Fatalf("status = %d; body=%s; want stale with no details", status, raw)
	}
}

// The open version reads as what it changed up to now, in the list and by
// its id, with the time of its last operation.
func TestTheOpenVersionHasItsChangeSummaryInAnAnswer(t *testing.T) {
	e := newTestEnv(t)
	typed := typeOp(t, e, e.doc.ID, fixtureEditor, 1, "op_1", replaceAt(fixtureHTML, "fixture", "typed", 0))
	for _, path := range []string{"/versions", "/versions/" + typed.VersionID} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+path, "", map[string]string{"X-Test-Principal": principalHeader(fixtureViewer)})
		assertStatus(t, rr, http.StatusOK)
		if body := rr.Body.String(); !strings.Contains(body, `"change_summary":"Changed “fixture” to “typed”"`) || !strings.Contains(body, `"open":true`) || !strings.Contains(body, `"edited_at":"`) {
			t.Fatalf("GET %s = %s; want the open version with its summary and edited_at", path, body)
		}
	}
}
