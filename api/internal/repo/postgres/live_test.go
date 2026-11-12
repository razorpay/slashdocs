package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"hash/crc32"
	"strconv"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/internal/textedit"
)

var (
	liveOwner = auth.Principal{Type: auth.PrincipalUser, ID: "usr_live", Email: "live@example.com", Name: "Owner"}
	liveOther = auth.Principal{Type: auth.PrincipalUser, ID: "usr_other", Email: "other@example.com", Name: "Other"}
)

// insert is the operation that puts text at the byte at of the source at
// baseSeq.
func insert(baseSeq int64, id string, at int, text string) repo.Operation {
	return repo.Operation{BaseSeq: baseSeq, ClientOpID: id, Replacements: []textedit.Replacement{{Start: at, End: at, NewHTML: text}}}
}

// exec runs statements that change what the clock of the database gave.
func exec(t *testing.T, store *pgrepo.Store, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := store.Pool().Exec(context.Background(), statement); err != nil {
			t.Fatal(err)
		}
	}
}

// sealIdle seals the open version of the document, as the background task
// does after 10 minutes with no operation.
func sealIdle(t *testing.T, store *pgrepo.Store, docID string) {
	t.Helper()
	exec(t, store, `UPDATE document_ops SET created_at = now() - interval '11 minutes' WHERE document_id = '`+docID+`'`)
	if _, err := store.SealIdleVersions(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// Each server has its own cache of the live state. A server whose cache is
// behind applies the operations that it lacks, and all servers give the
// same states.
func TestTwoServersGiveTheSameStates(t *testing.T) {
	ctx := context.Background()
	first := newStore(t)
	blobs := blob.NewMemory()
	// The two stores are two servers on one database and one blob store.
	a, b := pgrepo.NewWithBlob(first.Pool(), blobs), pgrepo.NewWithBlob(first.Pool(), blobs)
	doc, ver, err := a.CreateDocument(ctx, liveOwner, "Live", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}

	// a has the state at seq 1 in its cache, and b has nothing.
	one, err := a.AppendOperation(ctx, doc.ID, insert(1, "op_a1", 6, " two"), liveOwner)
	if err != nil || one.Seq != 2 || len(one.Others) != 0 || one.Sum != crc32.ChecksumIEEE([]byte("<p>one two</p>")) {
		t.Fatalf("first operation = %+v, %v", one, err)
	}
	// b makes the state at seq 2 from the snapshot and the operation of a.
	two, err := b.AppendOperation(ctx, doc.ID, insert(2, "op_b1", 10, " three"), liveOwner)
	if err != nil || two.Seq != 3 || two.VersionID != one.VersionID || len(two.Others) != 0 {
		t.Fatalf("second operation = %+v, %v", two, err)
	}
	// The cache of a ends at seq 2. Its next operation is on that seq, so a
	// applies the operation of b and moves its own over it.
	three, err := a.AppendOperation(ctx, doc.ID, insert(2, "op_a2", 3, "zero "), liveOwner)
	if err != nil || three.Seq != 4 {
		t.Fatalf("third operation = %+v, %v", three, err)
	}
	// The sender holds "<p>zero one two</p>", and gets the operation of b
	// as it applies to that.
	want := textedit.Replacement{Start: 15, End: 15, NewHTML: " three"}
	if len(three.Others) != 1 || len(three.Others[0]) != 1 || three.Others[0][0] != want {
		t.Fatalf("others = %+v, want %+v", three.Others, want)
	}
	// A retry that reaches the other server finds the operation.
	again, err := b.AppendOperation(ctx, doc.ID, insert(2, "op_a2", 3, "zero "), liveOwner)
	if err != nil || again.Seq != 4 || again.Sum != three.Sum || len(again.Others) != 1 || again.Others[0][0] != want {
		t.Fatalf("retry on the other server = %+v, %v; want the answer of the first attempt", again, err)
	}

	const live = "<p>zero one two three</p>"
	for name, store := range map[string]*pgrepo.Store{"a": a, "b": b, "a server with no cache": pgrepo.NewWithBlob(first.Pool(), blobs)} {
		if got, seq, err := store.GetVersionHTMLAt(ctx, one.VersionID, repo.LiveSeq); err != nil || string(got) != live || seq != 4 {
			t.Fatalf("%s: live document = %q at %d, %v; want %q at 4", name, got, seq, err, live)
		}
		for seq, want := range map[int64]string{1: "<p>one</p>", 2: "<p>one two</p>", 3: "<p>one two three</p>", 4: live} {
			if got, _, err := store.GetVersionHTMLAt(ctx, one.VersionID, seq); err != nil || string(got) != want {
				t.Fatalf("%s: state at %d = %q, %v; want %q", name, seq, got, err, want)
			}
		}
		if got, err := store.GetVersionHTML(ctx, ver.ID); err != nil || string(got) != "<p>one</p>" {
			t.Fatalf("%s: first version = %q, %v", name, got, err)
		}
		if _, _, err := store.GetVersionHTMLAt(ctx, one.VersionID, 5); !errors.Is(err, repo.ErrStale) {
			t.Fatalf("%s: state after the live seq: err = %v, want %v", name, err, repo.ErrStale)
		}
		changes, err := store.ChangesAfter(ctx, doc.ID, 2)
		if err != nil || changes.Seq != 4 || len(changes.Ops) != 2 || changes.Sum != three.Sum {
			t.Fatalf("%s: changes after 2 = %+v, %v", name, changes, err)
		}
		// The operations are as they applied, each on the state before it.
		var last []textedit.Replacement
		if err := json.Unmarshal(changes.Ops[1], &last); err != nil || len(last) != 1 || last[0] != (textedit.Replacement{Start: 3, End: 3, NewHTML: "zero "}) {
			t.Fatalf("%s: last operation = %s, %v", name, changes.Ops[1], err)
		}
		if _, err := store.ChangesAfter(ctx, doc.ID, 5); !errors.Is(err, repo.ErrNoSuchSeq) {
			t.Fatalf("%s: changes after the live seq: err = %v, want %v", name, err, repo.ErrNoSuchSeq)
		}
	}

	// b seals the version, and a pushes a file that was made from the first
	// version. The push moves over the three operations.
	sealIdle(t, b, doc.ID)
	pushed, onto, err := a.SaveVersion(ctx, doc.ID, ver.ID, nil, liveOwner, repo.Upload([]byte("<p>one</p><p>end</p>"), "Added the end"))
	if err != nil || onto.VersionID != one.VersionID || !onto.Rebased || pushed.Number != 3 || pushed.Seq != 5 || pushed.ChangeSummary != "Added the end" {
		t.Fatalf("push = %+v on %+v, %v", pushed, onto, err)
	}
	for name, store := range map[string]*pgrepo.Store{"a": a, "b": b} {
		if got, err := store.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>zero one two three</p><p>end</p>" {
			t.Fatalf("%s: pushed version = %q, %v", name, got, err)
		}
		if got, err := store.GetVersionHTML(ctx, one.VersionID); err != nil || string(got) != live {
			t.Fatalf("%s: typed version = %q, %v", name, got, err)
		}
	}
}

// A sitting of two people is one version. The background task seals it 10
// minutes after its last operation, and the next operation opens a version.
func TestTheTaskSealsAVersionWhenTheTypingStopped(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Done", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	open := func(v string) bool {
		t.Helper()
		version, err := store.GetVersion(ctx, v)
		if err != nil {
			t.Fatal(err)
		}
		return version.Open
	}
	mine, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, insert(2, "op_2", 3, "zero "), liveOther); err != nil {
		t.Fatal(err)
	}
	exec(t, store, `UPDATE document_ops SET created_at = now() - interval '9 minutes' WHERE document_id = '`+doc.ID+`'`)
	if n, err := store.SealIdleVersions(ctx); err != nil || n != 0 || !open(mine.VersionID) {
		t.Fatalf("sealed %d versions, %v; want none before 10 minutes", n, err)
	}
	// The first operation is old, and the last one is not.
	exec(t, store, `UPDATE document_ops SET created_at = now() - interval '11 minutes' WHERE document_id = '`+doc.ID+`' AND seq = 2`)
	if n, err := store.SealIdleVersions(ctx); err != nil || n != 0 || !open(mine.VersionID) {
		t.Fatalf("sealed %d versions, %v; want none while the last operation is new", n, err)
	}
	exec(t, store, `UPDATE document_ops SET created_at = now() - interval '11 minutes' WHERE document_id = '`+doc.ID+`'`)
	if n, err := store.SealIdleVersions(ctx); err != nil || n != 1 || open(mine.VersionID) {
		t.Fatalf("sealed %d versions, %v; want the idle one", n, err)
	}
	sealed, err := store.GetVersion(ctx, mine.VersionID)
	if err != nil || sealed.SHA256 == "" || sealed.ChangeSummary != "Rewrote a paragraph" || sealed.Seq != 3 {
		t.Fatalf("sealed version = %+v, %v; want its content, summary and seq", sealed, err)
	}
	if got := sealed.Authors; len(got) != 2 || got[0].ID != liveOwner.ID || got[1].ID != liveOther.ID {
		t.Fatalf("authors = %+v, want the owner and the other person", got)
	}
	if got, err := store.GetVersionHTML(ctx, mine.VersionID); err != nil || string(got) != "<p>zero one two</p>" {
		t.Fatalf("sealed content = %q, %v", got, err)
	}
	next, err := store.AppendOperation(ctx, doc.ID, insert(3, "op_3", 3, "And "), liveOther)
	if err != nil || next.VersionID == mine.VersionID {
		t.Fatalf("next operation = %+v, %v; want a new version", next, err)
	}
	if n, err := store.SealIdleVersions(ctx); err != nil || n != 0 {
		t.Fatalf("sealed %d versions, %v; want none after a new operation", n, err)
	}
}

// One person changes a tag that another one takes out at the same time. The
// change of the tag goes with the tag, in both orders, and the server takes
// both operations.
func TestAChangeOfATagThatAnotherPersonTakesOutGoesWithIt(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	cases := []struct{ base, change, gone string }{
		{"<p>a</p><p>b</p><p>c</p>", "<p>a</p><h2>b</h2><p>c</p>", "<p>a</p><p>c</p>"},
		{"<p>a</p><p>b</p><p>c</p>", `<p>a</p><p class="x">b</p><p>c</p>`, "<p>a</p><p>c</p>"},
		{`<p>Hello <a href="https://a.com">link</a> end</p>`, `<p>Hello <a href="https://b.com">link</a> end</p>`, "<p>Hello link end</p>"},
		{"<p>foo</p><p>bar</p>", `<p>foo</p><p class="x">bar</p>`, "<p>foar</p>"},
	}
	for _, tc := range cases {
		for _, order := range [][2]string{{tc.change, tc.gone}, {tc.gone, tc.change}} {
			doc, _, err := store.CreateDocument(ctx, liveOwner, "Tags", "", []byte(tc.base))
			if err != nil {
				t.Fatal(err)
			}
			var last repo.OperationResult
			for i, source := range order {
				op := repo.Operation{BaseSeq: 1, ClientOpID: "op_" + strconv.Itoa(i), Replacements: textedit.Between([]byte(tc.base), []byte(source))}
				if last, err = store.AppendOperation(ctx, doc.ID, op, liveOther); err != nil {
					t.Fatalf("%q, then %q: operation %d: %v", order[0], order[1], i+1, err)
				}
			}
			if got, err := store.GetVersionHTML(ctx, last.VersionID); err != nil || string(got) != tc.gone {
				t.Fatalf("%q, then %q: content = %q, %v; want %q", order[0], order[1], got, err, tc.gone)
			}
		}
	}
}

// The log keeps the replacements of the operations of a version for 10
// minutes after its seal. A seq from before then is stale, and History still
// has the authors. The rows stay for 7 days: an editor whose answer was lost
// sends the operation again after a long time, and learns that the document
// has it.
func TestOldOperationsLoseTheirReplacementsAndThenGo(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Old", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	sealIdle(t, store, doc.ID)
	// tend runs the task with the seal and the operations at an age.
	tend := func(age string) (emptied, deleted int) {
		t.Helper()
		exec(t, store,
			`UPDATE versions SET sealed_at = now() - interval '`+age+`' WHERE id = '`+typed.VersionID+`'`,
			`UPDATE document_ops SET created_at = now() - interval '`+age+`' WHERE document_id = '`+doc.ID+`'`)
		emptied, deleted, err := store.DeleteOldOperations(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return emptied, deleted
	}
	// After 9 minutes a page that was behind across the seal still follows.
	if emptied, deleted := tend("9 minutes"); emptied != 0 || deleted != 0 {
		t.Fatalf("emptied %d and deleted %d operations 9 minutes after the seal, want none", emptied, deleted)
	}
	if again, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther); err != nil || again.Seq != typed.Seq {
		t.Fatalf("repeat while the log holds the operation = %+v, %v; want the first answer", again, err)
	}
	if emptied, deleted := tend("11 minutes"); emptied != 1 || deleted != 0 {
		t.Fatalf("emptied %d and deleted %d operations 11 minutes after the seal, want 1 and 0", emptied, deleted)
	}
	// A server with no cache gives the document from the version.
	fresh := pgrepo.NewWithBlob(store.Pool(), blobsOf(t, store, typed.VersionID))
	if got, err := fresh.GetVersionHTML(ctx, typed.VersionID); err != nil || string(got) != "<p>one two</p>" {
		t.Fatalf("content = %q, %v", got, err)
	}
	if _, err := store.ChangesAfter(ctx, doc.ID, 1); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("changes after an operation with no replacements: err = %v, want %v", err, repo.ErrStale)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_late", 3, "x"), liveOwner); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("operation on a seq before the log: err = %v, want %v", err, repo.ErrStale)
	}
	if changes, err := store.ChangesAfter(ctx, doc.ID, 2); err != nil || len(changes.Ops) != 0 || changes.Sum != typed.Sum {
		t.Fatalf("changes after the live seq = %+v, %v", changes, err)
	}
	if v, err := store.GetVersion(ctx, typed.VersionID); err != nil || len(v.Authors) != 1 || v.Authors[0].ID != liveOther.ID {
		t.Fatalf("authors = %+v, %v; want the person who typed", v.Authors, err)
	}
	// The tab comes back and sends the same body. Its text is in the
	// document, and must not go in again.
	if _, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther); !errors.Is(err, repo.ErrApplied) {
		t.Fatalf("repeat after the replacements went: err = %v, want %v", err, repo.ErrApplied)
	}
	if d, err := store.GetDocument(ctx, doc.ID); err != nil || d.Seq != typed.Seq {
		t.Fatalf("document = seq %d, %v; want %d: the repeat applied nothing", d.Seq, err, typed.Seq)
	}
	if next, err := store.AppendOperation(ctx, doc.ID, insert(2, "op_next", 3, "x"), liveOwner); err != nil || next.Seq != 3 {
		t.Fatalf("operation on the live seq = %+v, %v", next, err)
	}
	exec(t, store, `UPDATE document_ops SET created_at = now() - interval '6 days' WHERE client_op_id = 'op_1'`)
	if emptied, deleted, err := store.DeleteOldOperations(ctx); err != nil || emptied != 0 || deleted != 0 {
		t.Fatalf("emptied %d and deleted %d operations after 6 days, %v; want none", emptied, deleted, err)
	}
	exec(t, store, `UPDATE document_ops SET created_at = now() - interval '8 days' WHERE client_op_id = 'op_1'`)
	if emptied, deleted, err := store.DeleteOldOperations(ctx); err != nil || emptied != 0 || deleted != 1 {
		t.Fatalf("emptied %d and deleted %d operations after 8 days, %v; want 0 and 1", emptied, deleted, err)
	}
	if text(t, store, `SELECT count(*)::text FROM document_ops WHERE document_id = $1`, doc.ID) != "1" {
		t.Fatal("the task deleted an operation of the open version")
	}
}

// A repeat of an operation gets the answer of the first attempt only when
// the log still gives the operations before it. Else the answer says that
// the document has the operation.
func TestARepeatWhoseFirstAnswerIsGoneSaysThatTheDocumentHasTheOperation(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Repeat", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther); err != nil {
		t.Fatal(err)
	}
	// The second operation was made on seq 1, so its answer has the first.
	second := insert(1, "op_2", 3, "zero ")
	first, err := store.AppendOperation(ctx, doc.ID, second, liveOwner)
	if err != nil || len(first.Others) != 1 {
		t.Fatalf("operation = %+v, %v; want one operation of the other person", first, err)
	}
	if again, err := store.AppendOperation(ctx, doc.ID, second, liveOwner); err != nil || again.Seq != first.Seq || len(again.Others) != 1 {
		t.Fatalf("repeat = %+v, %v; want the first answer", again, err)
	}
	exec(t, store, `UPDATE document_ops SET replacements = NULL WHERE document_id = '`+doc.ID+`' AND seq = 2`)
	if _, err := store.AppendOperation(ctx, doc.ID, second, liveOwner); !errors.Is(err, repo.ErrApplied) {
		t.Fatalf("repeat when the log lost the operation before it: err = %v, want %v", err, repo.ErrApplied)
	}
}

// blobsOf returns a blob store with the content of a sealed version, as the
// store gives it.
func blobsOf(t *testing.T, store *pgrepo.Store, versionID string) blob.Store {
	t.Helper()
	html, err := store.GetVersionHTML(context.Background(), versionID)
	if err != nil {
		t.Fatal(err)
	}
	var key string
	if err := store.Pool().QueryRow(context.Background(), `SELECT html_blob_key FROM versions WHERE id = $1`, versionID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	blobs := blob.NewMemory()
	if err := blobs.Put(context.Background(), key, "text/html", html); err != nil {
		t.Fatal(err)
	}
	return blobs
}

// An open version gets a new snapshot after many operations, so that a
// server with no cache does not replay them all. The snapshot before goes,
// but not the content of the version before.
func TestOpenVersionGetsSnapshots(t *testing.T) {
	ctx := context.Background()
	first := newStore(t)
	blobs := blob.NewMemory()
	store := pgrepo.NewWithBlob(first.Pool(), blobs)
	doc, ver, err := store.CreateDocument(ctx, liveOwner, "Long", "", []byte("<p></p>"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func(versionID string) (key string, seq int64) {
		t.Helper()
		if err := store.Pool().QueryRow(ctx, `SELECT html_blob_key, seq FROM versions WHERE id = $1`, versionID).Scan(&key, &seq); err != nil {
			t.Fatal(err)
		}
		return key, seq
	}
	parent, _ := snapshot(ver.ID)
	var op repo.OperationResult
	keys := map[string]bool{}
	for i := range 1001 {
		if op, err = store.AppendOperation(ctx, doc.ID, insert(int64(i+1), "op_"+strconv.Itoa(i), 3, "x"), liveOwner); err != nil {
			t.Fatal(err)
		}
		key, _ := snapshot(op.VersionID)
		keys[key] = true
	}
	key, seq := snapshot(op.VersionID)
	if seq != 1001 || len(keys) != 3 || !keys[parent] {
		t.Fatalf("snapshot %s at seq %d of the keys %v; want the third one, at 1001, after the content of the first version", key, seq, keys)
	}
	for old := range keys {
		_, _, err := blobs.Get(ctx, old)
		if kept := old == parent || old == key; kept != (err == nil) {
			t.Fatalf("blob %s: err = %v, kept should be %v", old, err, kept)
		}
	}
	want := "<p>" + strings.Repeat("x", 1001) + "</p>"
	fresh := pgrepo.NewWithBlob(first.Pool(), blobs)
	if got, at, err := fresh.GetVersionHTMLAt(ctx, op.VersionID, repo.LiveSeq); err != nil || string(got) != want || at != 1002 {
		t.Fatalf("live document of a server with no cache = %d bytes at %d, %v; want %d at 1002", len(got), at, err, len(want))
	}
	// The seal writes the content and takes the last snapshot away.
	sealIdle(t, store, doc.ID)
	if _, _, err := blobs.Get(ctx, key); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("snapshot after the seal: err = %v, want it gone", err)
	}
	if got, err := fresh.GetVersionHTML(ctx, op.VersionID); err != nil || string(got) != want {
		t.Fatalf("sealed content = %d bytes, %v", len(got), err)
	}
	if got, err := fresh.GetVersionHTML(ctx, ver.ID); err != nil || string(got) != "<p></p>" {
		t.Fatalf("first version = %q, %v", got, err)
	}
}

// An open version keeps the document in search with the text of the version
// before it, and its own text is there after the seal.
func TestSearchTextOfAVersionIsWrittenWhenItIsSealed(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Notes", "", []byte("<p>apricot</p>"))
	if err != nil {
		t.Fatal(err)
	}
	found := func(term string) bool {
		t.Helper()
		docs, _, err := store.SearchDocuments(ctx, liveOwner, repo.DocumentSearch{Terms: []string{term}}, false, repo.Page{Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		return len(docs) == 1 && docs[0].ID == doc.ID
	}
	if _, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 10, " blueberry"), liveOwner); err != nil {
		t.Fatal(err)
	}
	if !found("apricot") || found("blueberry") {
		t.Fatalf("search with an open version: apricot %v, blueberry %v; want true, false", found("apricot"), found("blueberry"))
	}
	sealIdle(t, store, doc.ID)
	if !found("apricot") || !found("blueberry") {
		t.Fatalf("search after the seal: apricot %v, blueberry %v; want both", found("apricot"), found("blueberry"))
	}
}
