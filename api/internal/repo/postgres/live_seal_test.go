package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/internal/textedit"
)

// servers returns two servers on one database and one blob store, each with
// its own cache, and the blob store.
func servers(t *testing.T) (a, b *pgrepo.Store, blobs *blob.Memory) {
	t.Helper()
	first := newStore(t)
	blobs = blob.NewMemory()
	return pgrepo.NewWithBlob(first.Pool(), blobs), pgrepo.NewWithBlob(first.Pool(), blobs), blobs
}

// text scans one text value.
func text(t *testing.T, store *pgrepo.Store, query string, args ...any) string {
	t.Helper()
	var out string
	if err := store.Pool().QueryRow(context.Background(), query, args...).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// One server types and seals in turns, while the other reads the document
// with no lock. A read that takes the seq of the document from before a
// seal, and the version from after it, keeps the content of the later seq
// as that of the earlier one. The server then applies an operation a second
// time, and the two servers give different text from then on.
func TestAServerThatReadsDuringSealsGivesTheTextOfTheOther(t *testing.T) {
	ctx := context.Background()
	a, b, _ := servers(t)
	doc, _, err := a.CreateDocument(ctx, liveOwner, "Two servers", "", []byte("<p></p>"))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var readers sync.WaitGroup
	for range 4 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-done:
					return
				default:
					// A seq after the live document: the read of the live
					// state comes before that answer.
					_, _ = b.ChangesAfter(ctx, doc.ID, 1<<40)
				}
			}
		}()
	}
	seq := int64(1)
	for i := range 300 {
		op, err := a.AppendOperation(ctx, doc.ID, insert(seq, fmt.Sprintf("op_%d", i), 3, "x"), liveOwner)
		if err != nil {
			t.Fatal(err)
		}
		seq = op.Seq
		sealIdle(t, a, doc.ID)
	}
	close(done)
	readers.Wait()
	want := "<p>" + strings.Repeat("x", 300) + "</p>"
	for name, store := range map[string]*pgrepo.Store{"a": a, "b": b} {
		d, err := store.GetDocument(ctx, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got, at, err := store.GetVersionHTMLAt(ctx, d.CurrentVersionID, repo.LiveSeq); err != nil || string(got) != want || at != seq {
			t.Fatalf("%s: live document = %d bytes at seq %d, %v; want %d bytes at seq %d", name, len(got), at, err, len(want), seq)
		}
		if changes, err := store.ChangesAfter(ctx, doc.ID, seq); err != nil || changes.Sum != crc32.ChecksumIEEE([]byte(want)) {
			t.Fatalf("%s: changes = %+v, %v; want the sum of the document", name, changes, err)
		}
	}
}

// Every version from before the log has seq 0. A file made from the first
// of them, pushed with base_seq 0, must not save over the versions after
// it: the base is the content of the version that the caller names.
func TestPushOnAVersionFromBeforeTheLogKeepsTheVersionsAfterIt(t *testing.T) {
	ctx := context.Background()
	a, fresh, _ := servers(t)
	doc, v1, err := a.CreateDocument(ctx, liveOwner, "Old", "", []byte("<p>one</p><p>two</p>"))
	if err != nil {
		t.Fatal(err)
	}
	v2, _, err := a.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, repo.Upload([]byte("<p>uno</p><p>two</p>"), "Two"))
	if err != nil {
		t.Fatal(err)
	}
	v3, _, err := a.SaveVersion(ctx, doc.ID, v2.ID, nil, liveOwner, repo.Upload([]byte("<p>uno</p><p>dos</p>"), "Three"))
	if err != nil {
		t.Fatal(err)
	}
	// The document as the migration found it: no log, and seq 0 everywhere.
	exec(t, a,
		`DELETE FROM document_ops WHERE document_id = '`+doc.ID+`'`,
		`UPDATE versions SET seq = 0 WHERE document_id = '`+doc.ID+`'`,
		`UPDATE documents SET seq = 0 WHERE id = '`+doc.ID+`'`)
	zero := int64(0)

	// The file changes text that the second version changed.
	_, _, err = fresh.SaveVersion(ctx, doc.ID, v1.ID, &zero, liveOwner, repo.Upload([]byte("<p>ONE</p><p>two</p>"), "Mine"))
	var conflict *repo.VersionConflictError
	if !errors.As(err, &conflict) || conflict.LatestVersionID != v3.ID {
		t.Fatalf("push over text of a later version: err = %v, want a conflict that names %s", err, v3.ID)
	}
	if d, err := fresh.GetDocument(ctx, doc.ID); err != nil || d.CurrentVersionID != v3.ID {
		t.Fatalf("current version = %s, %v; want %s: the push saved nothing", d.CurrentVersionID, err, v3.ID)
	}

	// The file changes other text. The later versions stay in the result.
	pushed, onto, err := fresh.SaveVersion(ctx, doc.ID, v1.ID, &zero, liveOwner, repo.Upload([]byte("<p>one</p><p>two</p><p>three</p>"), "End"))
	if err != nil || !onto.Rebased || onto.VersionID != v3.ID {
		t.Fatalf("push = %+v on %+v, %v; want a merge on %s", pushed, onto, err, v3.ID)
	}
	if got, err := fresh.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>uno</p><p>dos</p><p>three</p>" {
		t.Fatalf("pushed version = %q, %v; want the text of the later versions and the new paragraph", got, err)
	}
}

// A page or an agent that is too far behind gets stale, and the server
// knows that from the seqs, before it reads the log.
func TestASeqTooFarBehindIsStale(t *testing.T) {
	ctx := context.Background()
	a, fresh, _ := servers(t)
	doc, _, err := a.CreateDocument(ctx, liveOwner, "Far", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := a.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner)
	if err != nil {
		t.Fatal(err)
	}
	// 2001 more operations, which change nothing.
	exec(t, a,
		fmt.Sprintf(`INSERT INTO document_ops(document_id, seq, version_id, author_type, author_id, typed, replacements, sum)
			SELECT '%s', seq, '%s', 'user', '%s', true, '[]', %d FROM generate_series(3, 2003) AS seq`, doc.ID, typed.VersionID, liveOwner.ID, typed.Sum),
		`UPDATE documents SET seq = 2003 WHERE id = '`+doc.ID+`'`)

	if _, err := fresh.ChangesAfter(ctx, doc.ID, 2); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("changes for a page 2001 operations behind: err = %v, want %v", err, repo.ErrStale)
	}
	if changes, err := fresh.ChangesAfter(ctx, doc.ID, 3); err != nil || len(changes.Ops) != 2000 {
		t.Fatalf("changes for a page 2000 operations behind = %d operations, %v", len(changes.Ops), err)
	}
	if _, err := fresh.AppendOperation(ctx, doc.ID, insert(2, "op_far", 3, "x"), liveOwner); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("operation 2001 operations behind: err = %v, want %v", err, repo.ErrStale)
	}
	if _, _, err := fresh.GetVersionHTMLAt(ctx, typed.VersionID, 2); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("source 2001 operations behind: err = %v, want %v", err, repo.ErrStale)
	}
	if next, err := fresh.AppendOperation(ctx, doc.ID, insert(3, "op_near", 3, "x"), liveOwner); err != nil || next.Seq != 2004 || len(next.Others) != 2000 {
		t.Fatalf("operation 2000 operations behind = seq %d with %d others, %v", next.Seq, len(next.Others), err)
	}
}

// The answer to an operation is lost, and a large push lands before the
// retry. The log does not hold a change that large, so no state before it
// can be made. The retry must still get the answer of the first attempt.
func TestRetryAfterALargePushGetsTheFirstAnswer(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Retry", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner)
	if err != nil {
		t.Fatal(err)
	}
	large := []byte("<p>one two</p><p>" + strings.Repeat("large ", 200_000) + "</p>")
	if _, _, err := store.SaveVersion(ctx, doc.ID, first.VersionID, &first.Seq, liveOther, repo.Upload(large, "Large")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ChangesAfter(ctx, doc.ID, first.Seq); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("changes over the large push: err = %v, want %v: the test needs a push that the log does not hold", err, repo.ErrStale)
	}
	again, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner)
	if err != nil || again.Seq != first.Seq || again.VersionID != first.VersionID || again.Sum != first.Sum || again.Others == nil || len(again.Others) != 0 {
		t.Fatalf("retry = %+v, %v; want the first answer %+v", again, err, first)
	}
	// The retry applied nothing.
	if d, err := store.GetDocument(ctx, doc.ID); err != nil || d.Seq != first.Seq+1 {
		t.Fatalf("document = seq %d, %v; want %d", d.Seq, err, first.Seq+1)
	}
}

// A document whose version cannot be sealed must not stop the seal of the
// others.
func TestAVersionThatCannotBeSealedDoesNotStopTheOthers(t *testing.T) {
	ctx := context.Background()
	a, fresh, blobs := servers(t)
	var versions []string
	for i := range 3 {
		doc, _, err := a.CreateDocument(ctx, liveOwner, fmt.Sprintf("Idle %d", i), "", []byte("<p>one</p>"))
		if err != nil {
			t.Fatal(err)
		}
		op, err := a.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner)
		if err != nil {
			t.Fatal(err)
		}
		versions = append(versions, op.VersionID)
	}
	exec(t, a, `UPDATE document_ops SET created_at = now() - interval '31 minutes'`)
	// The document that the task finds first has no blob, so a server with
	// no cache cannot make its content.
	broken := text(t, a, `SELECT v.id FROM versions v WHERE v.sealed_at IS NULL ORDER BY v.document_id LIMIT 1`)
	if err := blobs.Delete(ctx, text(t, a, `SELECT html_blob_key FROM versions WHERE id = $1`, broken)); err != nil {
		t.Fatal(err)
	}
	if n, err := fresh.SealIdleVersions(ctx); err != nil || n != 2 {
		t.Fatalf("sealed %d versions, %v; want the 2 that can be sealed", n, err)
	}
	for _, id := range versions {
		v, err := fresh.GetVersion(ctx, id)
		if err != nil || v.Open != (id == broken) {
			t.Fatalf("version %s: open = %v, %v; want only %s open", id, v.Open, err, broken)
		}
	}
}

// A server of the release before saves a version over an open one, which
// is then open and not current. The task seals it.
func TestTheTaskSealsAnOpenVersionThatIsNotCurrent(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Stray", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	op, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOwner)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, store, `UPDATE documents SET current_version_id = '`+v1.ID+`' WHERE id = '`+doc.ID+`'`)
	if n, err := store.SealIdleVersions(ctx); err != nil || n != 1 {
		t.Fatalf("sealed %d versions, %v; want the one that is not current", n, err)
	}
	if v, err := store.GetVersion(ctx, op.VersionID); err != nil || v.Open {
		t.Fatalf("version = %+v, %v; want sealed", v, err)
	}
	if n, err := store.SealIdleVersions(ctx); err != nil || n != 0 {
		t.Fatalf("second run sealed %d versions, %v; want none", n, err)
	}
}

// A person types a word and takes it out again. The sitting ends on the
// text where it started, so it is not a version: the version before is the
// current one again, and a page that is behind still follows by seq.
func TestASittingThatChangesNothingIsNotAVersion(t *testing.T) {
	ctx := context.Background()
	a, fresh, _ := servers(t)
	doc, v1, err := a.CreateDocument(ctx, liveOwner, "Undo", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := a.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	// A comment that a person makes on the open version must stay.
	comment, err := a.CreateComment(ctx, doc.ID, typed.VersionID, "A note", repo.Anchor{Quote: "one"}, 0, liveOther, nil)
	if err != nil {
		t.Fatal(err)
	}
	removed, err := a.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 2, ClientOpID: "op_2", Replacements: []textedit.Replacement{{Start: 6, End: 10, OldHTML: " two"}}}, liveOther)
	if err != nil || removed.Sum != crc32.ChecksumIEEE([]byte("<p>one</p>")) {
		t.Fatalf("second operation = %+v, %v", removed, err)
	}
	sealIdle(t, a, doc.ID)

	for name, store := range map[string]*pgrepo.Store{"the server that sealed": a, "another server": fresh} {
		versions, err := store.ListVersions(ctx, doc.ID)
		if err != nil || len(versions) != 1 || versions[0].ID != v1.ID || versions[0].Open || versions[0].Seq != 3 {
			t.Fatalf("%s: versions = %+v, %v; want only the first one, at seq 3", name, versions, err)
		}
		d, err := store.GetDocument(ctx, doc.ID)
		if err != nil || d.CurrentVersionID != v1.ID || d.Seq != 3 {
			t.Fatalf("%s: document = %+v, %v; want the first version at seq 3", name, d, err)
		}
		if got, at, err := store.GetVersionHTMLAt(ctx, v1.ID, repo.LiveSeq); err != nil || string(got) != "<p>one</p>" || at != 3 {
			t.Fatalf("%s: content = %q at seq %d, %v", name, got, at, err)
		}
		// A page at seq 2, in the version that is gone, follows to seq 3.
		changes, err := store.ChangesAfter(ctx, doc.ID, 2)
		if err != nil || changes.Seq != 3 || changes.VersionID != v1.ID || len(changes.Ops) != 1 || changes.Sum != removed.Sum {
			t.Fatalf("%s: changes after 2 = %+v, %v; want the last operation, in the first version", name, changes, err)
		}
	}
	if _, err := a.GetVersion(ctx, typed.VersionID); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("the version of the sitting: err = %v, want %v", err, repo.ErrNotFound)
	}
	if got := text(t, a, `SELECT created_on_version_id FROM comments WHERE id = $1`, comment.ID); got != v1.ID {
		t.Fatalf("the comment is on version %s, want %s", got, v1.ID)
	}
	// The stored event tells the pages that History changed.
	events, err := a.ListDocumentKVEvents(ctx, doc.ID, 0, 100)
	if err != nil || len(events) == 0 {
		t.Fatalf("events = %+v, %v", events, err)
	}
	var last repo.DocumentPosition
	if err := json.Unmarshal(events[len(events)-1].Data, &last); err != nil || last != (repo.DocumentPosition{Seq: 3, VersionID: v1.ID, Sealed: true}) {
		t.Fatalf("last event = %s, %v; want seq 3 of the first version, sealed", events[len(events)-1].Data, err)
	}

	// An operation from a page that was at seq 2 still applies, and the
	// next version has the number that the sitting had.
	late, err := fresh.AppendOperation(ctx, doc.ID, insert(2, "op_late", 3, "zero "), liveOwner)
	if err != nil || late.Seq != 4 || len(late.Others) != 1 {
		t.Fatalf("late operation = %+v, %v; want seq 4 over one operation", late, err)
	}
	if v, err := fresh.GetVersion(ctx, late.VersionID); err != nil || v.Number != 2 || !v.Open {
		t.Fatalf("next version = %+v, %v; want number 2, open", v, err)
	}
	if got, err := a.GetVersionHTML(ctx, late.VersionID); err != nil || string(got) != "<p>zero one</p>" {
		t.Fatalf("live document = %q, %v", got, err)
	}
}

// A push while a person has such a sitting open is saved on the version
// before, with no version for the sitting.
func TestPushAfterASittingThatChangesNothingIsOnTheVersionBefore(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Undo", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 2, ClientOpID: "op_2", Replacements: []textedit.Replacement{{Start: 6, End: 10, OldHTML: " two"}}}, liveOther); err != nil {
		t.Fatal(err)
	}
	pushed, onto, err := store.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, repo.Upload([]byte("<p>one</p><p>end</p>"), "End"))
	if err != nil || onto.VersionID != v1.ID || pushed.Number != 2 || pushed.Seq != 4 {
		t.Fatalf("push = %+v on %+v, %v; want version 2 on the first version, at seq 4", pushed, onto, err)
	}
	if got, err := store.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>one</p><p>end</p>" {
		t.Fatalf("pushed version = %q, %v", got, err)
	}
}

// History shows the summaries of a version in one entry, so their count has
// a limit.
func TestASealJoinsALimitedCountOfSummaries(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Summaries", "", []byte("<p></p>"))
	if err != nil {
		t.Fatal(err)
	}
	var version string
	for i := range 25 {
		op := insert(int64(i+1), fmt.Sprintf("op_%d", i), 3, "x")
		op.Summary = fmt.Sprintf("Change %d", i)
		out, err := store.AppendOperation(ctx, doc.ID, op, liveOwner)
		if err != nil {
			t.Fatal(err)
		}
		version = out.VersionID
	}
	sealIdle(t, store, doc.ID)
	v, err := store.GetVersion(ctx, version)
	if lines := strings.Split(v.ChangeSummary, "\n"); err != nil || len(lines) != 20 || lines[0] != "Change 0" || lines[19] != "Change 19" {
		t.Fatalf("summary = %q, %v; want the first 20 summaries", v.ChangeSummary, err)
	}
}

// An agent pulls the open version while a person types. The person types
// more and is done, so the version is sealed at a later seq, and the agent
// pushes with the seq of its pull. The base is the document at that seq, and
// not the content of the version: else the push takes out the text that the
// person typed after the pull.
func TestPushFromAPullOfAnOpenVersionKeepsTheTextTypedAfterIt(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Pull", "", []byte("<p>one</p><p>end</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	pulled, at, err := store.GetVersionHTMLAt(ctx, typed.VersionID, repo.LiveSeq)
	if err != nil || string(pulled) != "<p>one two</p><p>end</p>" || at != 2 {
		t.Fatalf("pull = %q at seq %d, %v", pulled, at, err)
	}
	end := strings.Index(string(pulled), "</p>")
	for i, word := range []string{" three", " four", " five"} {
		if _, err := store.AppendOperation(ctx, doc.ID, insert(at+int64(i), "op"+word, end, word), liveOther); err != nil {
			t.Fatal(err)
		}
		end += len(word)
	}
	sealIdle(t, store, doc.ID)
	if v, err := store.GetVersion(ctx, typed.VersionID); err != nil || v.Open || v.Seq != 5 {
		t.Fatalf("version = %+v, %v; want sealed at seq 5", v, err)
	}

	// The file changes text that the person typed after the pull.
	_, _, err = store.SaveVersion(ctx, doc.ID, typed.VersionID, &at, liveOwner, repo.Upload([]byte("<p>one two.</p><p>end</p>"), "Stop"))
	var conflict *repo.VersionConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("push at the point where the person typed on: err = %v, want a conflict", err)
	}
	// The file changes other text. The text of the person stays.
	pushed, onto, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, &at, liveOwner, repo.Upload([]byte("<p>one two</p><p>END</p>"), "End"))
	if err != nil || !onto.Rebased || onto.VersionID != typed.VersionID {
		t.Fatalf("push = %+v on %+v, %v; want a merge on the sealed version", pushed, onto, err)
	}
	if got, err := store.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>one two three four five</p><p>END</p>" {
		t.Fatalf("pushed version = %q, %v; want the text that the person typed after the pull", got, err)
	}

	// The seq of the sealed version, and no seq, name its content.
	five := int64(5)
	const sealed = "<p>one two three four five</p><p>end</p>"
	for html, seq := range map[string]*int64{"<h1>Its seq</h1>" + sealed: &five, sealed + "<p>No seq</p>": nil} {
		v, onto, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, seq, liveOwner, repo.Upload([]byte(html), ""))
		if err != nil || !onto.Rebased {
			t.Fatalf("push of %q on the sealed version = %+v on %+v, %v", html, v, onto, err)
		}
	}
	d, err := store.GetDocument(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if live, err := store.GetVersionHTML(ctx, d.CurrentVersionID); err != nil || string(live) != "<h1>Its seq</h1><p>one two three four five</p><p>END</p><p>No seq</p>" {
		t.Fatalf("document = %q, %v", live, err)
	}
	// A seq before the version is not a state of it.
	zero := int64(0)
	if _, _, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, &zero, liveOwner, repo.Upload([]byte("<p>x</p>"), "")); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("push with a seq before the version: err = %v, want %v", err, repo.ErrStale)
	}
	// The log no longer has the state of the pull.
	exec(t, store, `DELETE FROM document_ops WHERE document_id = '`+doc.ID+`'`)
	if _, _, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, &at, liveOwner, repo.Upload([]byte("<p>x</p>"), "")); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("push with a seq that the log no longer has: err = %v, want %v", err, repo.ErrStale)
	}
}

// A push of content that is the document makes no version, also when its
// base is older: an author whose answer was lost sends the push again.
func TestPushOfTheDocumentAsItIsMakesNoVersion(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Same", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	versions := func() int {
		t.Helper()
		list, err := store.ListVersions(ctx, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		return len(list)
	}
	same, onto, err := store.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, repo.Upload([]byte("<p>one</p>"), ""))
	if err != nil || !onto.Unchanged || same.ID != v1.ID || onto.VersionID != v1.ID || same.Seq != 1 || versions() != 1 {
		t.Fatalf("push of the same content = %+v on %+v, %v, %d versions; want the first version, unchanged", same, onto, err, versions())
	}
	v2, onto, err := store.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, repo.Upload([]byte("<p>two</p>"), ""))
	if err != nil || onto.Unchanged {
		t.Fatalf("push = %+v on %+v, %v", v2, onto, err)
	}
	// The answer was lost, and the author sends the push again.
	again, onto, err := store.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, repo.Upload([]byte("<p>two</p>"), ""))
	if err != nil || !onto.Unchanged || again.ID != v2.ID || again.SHA256 != v2.SHA256 || versions() != 2 {
		t.Fatalf("second push = %+v on %+v, %v, %d versions; want the second version, unchanged", again, onto, err, versions())
	}
	// The live document changes nothing and seals nothing, also from an
	// older base. The content of the caller is then the document at the live
	// seq.
	typed, err := store.AppendOperation(ctx, doc.ID, insert(2, "op_1", 6, " three"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	open, onto, err := store.SaveVersion(ctx, doc.ID, v2.ID, nil, liveOwner, repo.Upload([]byte("<p>two three</p>"), ""))
	if err != nil || !onto.Unchanged || open.ID != typed.VersionID || open.Seq != 3 || !open.Open || versions() != 3 {
		t.Fatalf("push of the live document = %+v on %+v, %v; want the open version at seq 3, unchanged", open, onto, err)
	}
}

// An agent pulls, a person types, and the agent pushes its file with no
// change of its own. The file is not the live document, so the answer must
// not give the live seq: with that seq as its base, the next push of the
// agent takes out the text of the person, with no conflict.
func TestAnUnchangedPushOfAnOlderFileAnswersItsBase(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	const pulled = "<p>one</p><p>end</p>"
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Base", "", []byte(pulled))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " typed"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	one := int64(1)
	for name, seq := range map[string]*int64{"its seq": &one, "no seq": nil} {
		same, onto, err := store.SaveVersion(ctx, doc.ID, v1.ID, seq, liveOwner, repo.Upload([]byte(pulled), ""))
		if err != nil || !onto.Unchanged || same.ID != v1.ID || onto.VersionID != v1.ID || same.Seq != 1 || same.SHA256 != v1.SHA256 {
			t.Fatalf("unchanged push with %s = %+v on %+v, %v; want the base of the caller: the first version at seq 1, with the hash of the file", name, same, onto, err)
		}
	}
	// A pull during the sitting, and the same push after more typing.
	if _, err := store.AppendOperation(ctx, doc.ID, insert(2, "op_2", 12, " more"), liveOther); err != nil {
		t.Fatal(err)
	}
	during, onto, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, &typed.Seq, liveOwner, repo.Upload([]byte("<p>one typed</p><p>end</p>"), ""))
	if err != nil || !onto.Unchanged || during.ID != typed.VersionID || during.Seq != typed.Seq {
		t.Fatalf("unchanged push from a pull of the sitting = %+v on %+v, %v; want that version at seq %d", during, onto, err, typed.Seq)
	}
	// The next push of the agent, on the base of the answer, keeps the text.
	pushed, onto, err := store.SaveVersion(ctx, doc.ID, during.ID, &during.Seq, liveOwner, repo.Upload([]byte("<p>one typed</p><p>END</p>"), ""))
	if err != nil || !onto.Rebased {
		t.Fatalf("push = %+v on %+v, %v; want a merge", pushed, onto, err)
	}
	if got, err := store.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>one typed more</p><p>END</p>" {
		t.Fatalf("pushed version = %q, %v; want the text that the person typed", got, err)
	}
}

// A person types and takes the text back, so the sitting is discarded with
// its version. An agent pulled during it. The log still holds that seq, so
// the push is made on the state of the pull.
func TestPushFromAPullOfASittingThatWasDiscardedIsOnItsSeq(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Gone", "", []byte("<p>one</p><p>end</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " x"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	back := repo.Operation{BaseSeq: 2, ClientOpID: "op_2", Replacements: []textedit.Replacement{{Start: 6, End: 8, OldHTML: " x"}}}
	if _, err := store.AppendOperation(ctx, doc.ID, back, liveOther); err != nil {
		t.Fatal(err)
	}
	sealIdle(t, store, doc.ID)
	if _, err := store.GetVersion(ctx, typed.VersionID); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("version of the sitting: err = %v, want %v", err, repo.ErrNotFound)
	}
	// With no seq, nothing names a state.
	if _, _, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, nil, liveOwner, repo.Upload([]byte("<p>x</p>"), "")); !errors.Is(err, repo.ErrBaseVersion) {
		t.Fatalf("push on the discarded version with no seq: err = %v, want %v", err, repo.ErrBaseVersion)
	}
	// The file of the pull with no change is the document at that seq.
	same, onto, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, &typed.Seq, liveOwner, repo.Upload([]byte("<p>one x</p><p>end</p>"), ""))
	if err != nil || !onto.Unchanged || same.ID != typed.VersionID || same.Seq != typed.Seq {
		t.Fatalf("unchanged push = %+v on %+v, %v; want the base of the caller", same, onto, err)
	}
	pushed, onto, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, &typed.Seq, liveOwner, repo.Upload([]byte("<p>one x</p><p>END</p>"), ""))
	if err != nil || !onto.Rebased || onto.VersionID != v1.ID {
		t.Fatalf("push = %+v on %+v, %v; want a merge on the first version", pushed, onto, err)
	}
	if got, err := store.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>one</p><p>END</p>" {
		t.Fatalf("pushed version = %q, %v; want the change of the push, without the text that the person took back", got, err)
	}
	// The log no longer holds the seq.
	exec(t, store, `UPDATE document_ops SET replacements = NULL WHERE document_id = '`+doc.ID+`'`)
	if _, _, err := store.SaveVersion(ctx, doc.ID, typed.VersionID, &typed.Seq, liveOwner, repo.Upload([]byte("<p>x</p>"), "")); !errors.Is(err, repo.ErrStale) {
		t.Fatalf("push on a seq that the log no longer has: err = %v, want %v", err, repo.ErrStale)
	}
}

// The diff and the summary of a push are made with no lock on the document,
// so a person can type during them. The push then counts that text: the
// work is done again.
func TestAPersonCanTypeWhileAPushIsMade(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Lock", "", []byte("<p>one</p><p>end</p>"))
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	change := func([]byte) ([]byte, string, error) {
		// The first call is the work before the lock.
		if calls++; calls == 1 {
			typing, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if _, err := store.AppendOperation(typing, doc.ID, insert(1, "op_1", 6, " typed"), liveOther); err != nil {
				t.Errorf("an operation during the work of a push: %v", err)
			}
		}
		return []byte("<p>one</p><p>END</p>"), "", nil
	}
	pushed, onto, err := store.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, change)
	if err != nil || !onto.Rebased || calls != 2 {
		t.Fatalf("push = %+v on %+v, %v, after %d calls; want a merge after 2", pushed, onto, err, calls)
	}
	if got, err := store.GetVersionHTML(ctx, pushed.ID); err != nil || string(got) != "<p>one typed</p><p>END</p>" {
		t.Fatalf("pushed version = %q, %v; want the text that the person typed during the push", got, err)
	}
}

// History shows a sitting as what it changed up to now, with the time of its
// last operation, and does not show a sitting that changed nothing.
func TestTheListOfVersionsShowsTheOpenVersionAsItIsNow(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "List", "", []byte("<p>one</p><p>end</p>"))
	if err != nil {
		t.Fatal(err)
	}
	listed := func() []repo.Version {
		t.Helper()
		versions, err := store.ListVersions(ctx, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		return versions
	}
	if got := listed(); len(got) != 1 || got[0].EditedAt != got[0].CreatedAt {
		t.Fatalf("versions = %+v, want one, edited when it was created", got)
	}
	typed, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_1", 6, " two"), liveOther)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, store, `UPDATE versions SET created_at = now() - interval '5 minutes' WHERE id = '`+typed.VersionID+`'`)
	got := listed()
	if len(got) != 2 || !got[1].Open || got[1].ChangeSummary != "Added “two”" || got[1].EditedAt <= got[1].CreatedAt {
		t.Fatalf("versions = %+v, want the open one with its summary and the time of its last operation", got)
	}
	if id, summary, err := store.LiveChangeSummary(ctx, doc.ID); err != nil || id != typed.VersionID || summary != "Added “two”" {
		t.Fatalf("live change summary = %q, %q, %v", id, summary, err)
	}
	// The person takes the text back: nothing changed, so History has no
	// entry for the sitting, and the time of the first version stays.
	back := repo.Operation{BaseSeq: 2, ClientOpID: "op_2", Replacements: []textedit.Replacement{{Start: 6, End: 10, OldHTML: " two"}}}
	if _, err := store.AppendOperation(ctx, doc.ID, back, liveOther); err != nil {
		t.Fatal(err)
	}
	if got := listed(); len(got) != 1 || got[0].ID != v1.ID {
		t.Fatalf("versions = %+v, want only the first while the sitting changed nothing", got)
	}
	sealIdle(t, store, doc.ID)
	if got := listed(); len(got) != 1 || got[0].EditedAt != got[0].CreatedAt {
		t.Fatalf("versions = %+v, want only the first, with its own time", got)
	}
	if id, summary, err := store.LiveChangeSummary(ctx, doc.ID); err != nil || id != "" || summary != "" {
		t.Fatalf("live change summary of a sealed document = %q, %q, %v; want none", id, summary, err)
	}
}

// A push in the middle of a sitting seals the sitting before it. History
// then shows one row for the sitting, at the time of its last operation and
// with what the people typed in whole words, and one row for the push. A
// sitting that ended long before a push stays its own row.
func TestHistoryShowsOneRowForASittingThatAPushCut(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Sitting", "", []byte("<p>one</p><p>end</p>"))
	if err != nil {
		t.Fatal(err)
	}
	typed := func(op repo.Operation, author auth.Principal) repo.OperationResult {
		t.Helper()
		got, err := store.AppendOperation(ctx, doc.ID, op, author)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	// A push on the live document.
	push := func(on repo.OperationResult, old, new string) repo.Version {
		t.Helper()
		v, _, err := store.SaveVersion(ctx, doc.ID, on.VersionID, &on.Seq, liveOwner, func(base []byte) ([]byte, string, error) {
			return []byte(strings.Replace(string(base), old, new, 1)), "", nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	pushed := push(typed(insert(1, "op_1", 6, " custo"), liveOther), "end", "END")
	typed(insert(pushed.Seq, "op_2", 12, "mer"), liveOwner)
	listed := func() []repo.Version {
		t.Helper()
		versions, err := store.ListVersions(ctx, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		return versions
	}
	for _, when := range []string{"while it goes on", "after its seal"} {
		got := listed()
		if len(got) != 3 || got[0].ID != v1.ID || got[1].ID != pushed.ID || got[2].ChangeSummary != "Added “customer”" || len(got[2].Authors) != 2 {
			t.Fatalf("%s: versions = %+v, want the first, the push, and one row for the sitting of two people", when, got)
		}
		sealIdle(t, store, doc.ID)
	}

	// The next sitting ends long before the next push.
	next := typed(insert(pushed.Seq+1, "op_3", 3, "One. "), liveOther)
	sealIdle(t, store, doc.ID)
	typed(insert(push(next, "END", "Done").Seq, "op_4", 3, "Zero. "), liveOther)
	if got := listed(); len(got) != 6 {
		t.Fatalf("versions = %+v, want a row for each sitting and each push", got)
	}
}

// A refused push names the sentence that holds the text of other people
// that it changes, in whole words with no tags.
func TestARefusedPushNamesTheTextOfOtherPeople(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, v1, err := store.CreateDocument(ctx, liveOwner, "Text", "", []byte("<p>The <b>TTL</b> is 10 minutes.</p><p>end</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 1, ClientOpID: "op_1", Replacements: []textedit.Replacement{{Start: 22, End: 23, OldHTML: "0", NewHTML: "2"}}}, liveOther); err != nil {
		t.Fatal(err)
	}
	_, _, err = store.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, repo.Upload([]byte("<p>The <b>TTL</b> is 15 minutes.</p><p>end</p>"), ""))
	var conflict *repo.VersionConflictError
	if !errors.As(err, &conflict) || conflict.Text != "The TTL is 10 minutes." {
		t.Fatalf("err = %+v, want a conflict on the sentence of the text 10", err)
	}
	_, _, err = store.SaveVersion(ctx, doc.ID, v1.ID, nil, liveOwner, repo.Upload([]byte("<p>end</p>"), ""))
	if !errors.As(err, &conflict) || conflict.Text != "The TTL is 10 minutes." {
		t.Fatalf("err = %+v, want a conflict on the words of the paragraph", err)
	}
}

// The log holds each operation in its one form, and no replacement that
// changes nothing: a browser cannot apply one.
func TestTheLogHoldsNoReplacementThatChangesNothing(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Normal", "", []byte("<p>abc</p>"))
	if err != nil {
		t.Fatal(err)
	}
	// ops gives the operations of the log after a seq, as Go values.
	ops := func(after int64) string {
		t.Helper()
		changes, err := store.ChangesAfter(ctx, doc.ID, after)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(changes.Ops)
		var log [][]textedit.Replacement
		if err := json.Unmarshal(raw, &log); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf("%+v", log)
	}
	// An editor sends a replacement of nothing with nothing before a real one.
	if _, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 1, ClientOpID: "op_1", Replacements: []textedit.Replacement{{}, {Start: 3, End: 6, OldHTML: "abc", NewHTML: "abXc"}}}, liveOwner); err != nil {
		t.Fatal(err)
	}
	if got, want := ops(1), "[[{Start:5 End:5 OldHTML: NewHTML:X}]]"; got != want {
		t.Fatalf("log = %s, want %s", got, want)
	}
	if _, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 2, ClientOpID: "op_none", Replacements: []textedit.Replacement{{}}}, liveOwner); err == nil {
		t.Fatal("an operation that changes nothing was saved")
	}

	// B takes out "a" and "c". A replaces "abXc" with "bX" on the same seq:
	// B took out all that A takes out.
	if _, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 2, ClientOpID: "op_b", Replacements: []textedit.Replacement{{Start: 3, End: 4, OldHTML: "a"}, {Start: 6, End: 7, OldHTML: "c"}}}, liveOther); err != nil {
		t.Fatal(err)
	}
	a, err := store.AppendOperation(ctx, doc.ID, repo.Operation{BaseSeq: 2, ClientOpID: "op_a", Replacements: []textedit.Replacement{{Start: 3, End: 7, OldHTML: "abXc", NewHTML: "bX"}}}, liveOwner)
	if err != nil || a.Seq != 4 || a.Sum != crc32.ChecksumIEEE([]byte("<p>bX</p>")) || len(a.Others) != 1 || len(a.Others[0]) != 0 {
		t.Fatalf("operation = %+v, %v; want seq 4 on <p>bX</p>, and nothing more to take out", a, err)
	}
	if got, want := ops(3), "[[]]"; got != want {
		t.Fatalf("log = %s, want %s: the operation changes nothing", got, want)
	}
}

// A large document does not make a page stale sooner. The work for an
// operation that is behind is that of the operations after its base, and
// not the size of the document for each of them: 200 operations on 5 MiB
// were stale before.
func TestAnOperationBehindOnALargeDocumentIsNotStale(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	large := "<p>one</p><p>" + strings.Repeat("large ", 5<<20/6) + "</p>"
	doc, _, err := store.CreateDocument(ctx, liveOwner, "Large", "", []byte(large))
	if err != nil {
		t.Fatal(err)
	}
	for i := range 200 {
		if _, err := store.AppendOperation(ctx, doc.ID, insert(int64(1+i), fmt.Sprintf("op_%d", i), 3, "x"), liveOther); err != nil {
			t.Fatal(err)
		}
	}
	out, err := store.AppendOperation(ctx, doc.ID, insert(1, "op_behind", len(large)-4, "!"), liveOwner)
	want := "<p>" + strings.Repeat("x", 200) + large[3:len(large)-4] + "!</p>"
	if err != nil || out.Seq != 202 || len(out.Others) != 200 || out.Sum != crc32.ChecksumIEEE([]byte(want)) {
		t.Fatalf("operation 200 operations behind = seq %d with %d others, %v; want seq 202 with the text of both", out.Seq, len(out.Others), err)
	}
	if got, _, err := store.GetVersionHTMLAt(ctx, out.VersionID, 1); err != nil || string(got) != large {
		t.Fatalf("source at seq 1 = %d bytes, %v; want the first content", len(got), err)
	}
}
