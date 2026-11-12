package postgres

import (
	"context"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/testdb"
	"github.com/razorpay/slashdocs/internal/textedit"
)

// A server reads the row of the document, and another server writes an
// operation and seals the version before the first one reads the version.
// The two rows then do not agree: the seq is that of the document before,
// and the blob is the content after. That state must not go into the
// cache, where the next read applies the operation to it a second time.
func TestAStateFromRowsThatDoNotAgreeIsNotCached(t *testing.T) {
	ctx := context.Background()
	store, err := Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_rows", Email: "rows@example.com", Name: "Owner"}
	doc, _, err := store.CreateDocument(ctx, owner, "Rows", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	insert := func(baseSeq int64, id, text string) {
		t.Helper()
		op := repo.Operation{BaseSeq: baseSeq, ClientOpID: id, Replacements: []textedit.Replacement{{Start: 6, End: 6, NewHTML: text}}}
		if _, err := store.AppendOperation(ctx, doc.ID, op, owner); err != nil {
			t.Fatal(err)
		}
	}
	insert(1, "op_1", " two")
	before, err := store.read(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	insert(2, "op_2", " and")
	if _, err := store.db.Exec(ctx, `UPDATE document_ops SET created_at = now() - interval '11 minutes'`); err != nil {
		t.Fatal(err)
	}
	if n, err := store.SealIdleVersions(ctx); err != nil || n != 1 {
		t.Fatalf("sealed %d versions, %v; want 1", n, err)
	}
	after, err := store.q.GetLiveVersion(ctx, before.version.ID)
	if err != nil {
		t.Fatal(err)
	}

	other := NewWithBlob(store.db, store.blobs)
	if state, err := other.current(ctx, other.q, live{id: doc.ID, seq: before.seq, version: after}); err == nil {
		t.Fatalf("the content of seq 3 is the state at seq %d: %q", state.seq, state.source)
	}
	if state, ok := other.states.get(doc.ID); ok {
		t.Fatalf("the cache holds %q as seq %d", state.source, state.seq)
	}
	// The read of one statement gives rows that agree.
	if at, state, err := other.view(ctx, doc.ID); err != nil || at.seq != 3 || string(state.source) != "<p>one and two</p>" {
		t.Fatalf("live state = %q at seq %d, %v", state.source, at.seq, err)
	}
}

func TestStateCacheKeepsTheLiveStateOfTheDocumentsUsedLast(t *testing.T) {
	c := newStateCache()
	if _, ok := c.get("doc_a"); ok {
		t.Fatal("an empty cache gave a state")
	}
	c.put("doc_a", newLiveState("ver_1", 5, []byte("five")))
	c.put("doc_a", newLiveState("ver_1", 4, []byte("four")))
	// A state that is behind does not replace a later one.
	if s, ok := c.get("doc_a"); !ok || s.seq != 5 || string(s.source) != "five" || !s.valid || s.sum != crc32.ChecksumIEEE([]byte("five")) {
		t.Fatalf("state = %+v, %v; want the state at seq 5 with its sum", s, ok)
	}
	c.put("doc_a", newLiveState("ver_2", 6, []byte("\xff")))
	if s, _ := c.get("doc_a"); s.seq != 6 || s.versionID != "ver_2" || s.valid || c.bytes != 1 {
		t.Fatalf("state = %+v with %d bytes, want the state at seq 6, which is not UTF-8", s, c.bytes)
	}

	// The documents used least recently go first.
	for i := range cachedDocuments {
		c.put(fmt.Sprintf("doc_%d", i), newLiveState("ver", 1, []byte("x")))
	}
	if _, ok := c.get("doc_a"); ok {
		t.Fatal("the cache kept more documents than its limit")
	}
	if _, ok := c.get("doc_0"); !ok {
		t.Fatal("the cache lost a document inside its limit")
	}
	if want := cachedDocuments; c.bytes != want || c.used.Len() != want || len(c.docs) != want {
		t.Fatalf("cache holds %d bytes of %d documents, want %d of %d", c.bytes, c.used.Len(), want, want)
	}

	// The byte limit takes the other documents, and keeps the one used last.
	half := make([]byte, cachedBytes/2+1)
	c.put("doc_big", newLiveState("ver", 1, half))
	c.put("doc_bigger", newLiveState("ver", 1, half))
	if _, ok := c.get("doc_bigger"); !ok || c.used.Len() != 1 || c.bytes != len(half) {
		t.Fatalf("after two large states: %d documents, %d bytes; want only the last one", c.used.Len(), c.bytes)
	}
}

// commitTx is a transaction whose commit gives err.
type commitTx struct {
	pgx.Tx
	err error
}

func (t commitTx) Commit(context.Context) error { return t.err }

// The blobs of the seals of a write go only when its commit surely did not
// happen: the server refused it. After a lost connection, the commit can be
// there, and a version can hold the blobs.
func TestCommitSealsKeepsTheBlobsUnlessTheServerRefusedTheCommit(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		kept bool
	}{
		{"committed", nil, true},
		{"lost connection", io.ErrUnexpectedEOF, true},
		{"refused", &pgconn.PgError{Code: "40001"}, false},
		{"rolled back", pgx.ErrTxCommitRollback, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kept, err := commitSeals(context.Background(), commitTx{err: tc.err})
			if kept != tc.kept || !errors.Is(err, tc.err) {
				t.Fatalf("commitSeals = %v, %v; want %v, %v", kept, err, tc.kept, tc.err)
			}
		})
	}
}
