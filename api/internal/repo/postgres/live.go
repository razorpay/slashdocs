package postgres

import (
	"bytes"
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/razorpay/slashdocs/api/internal/auth"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/textedit"
)

// The live document. An edit is an operation in the log of its document
// (document_ops), and documents.seq is the number of the last one. The live
// document is the source at that seq. A version is a checkpoint: the newest
// one is open while people type. It is sealed when nobody typed for some
// time, and before a write that is not typing or an approval. The
// blob of an open version is a snapshot, and the operations after it
// complete it. Every write locks the row of its document, so the operations
// of a document have one order on all servers.

const (
	// The background task seals a version when its last operation is older
	// than sealIdleAfter. A sitting ends only then, or when a write that is
	// not typing or an approval needs a version that does not change.
	sealIdleAfter = 10 * time.Minute
	// A person still types when their last operation is less than
	// typingQuiet ago.
	typingQuiet = 10 * time.Second
	// The operations of a version keep their replacements for operationsKept
	// after its seal, for the pages that are behind. After that, text that a
	// person typed and removed is in no place.
	operationsKept = 10 * time.Minute
	// The row of an operation stays for operationRowsKept, so that a tab
	// that comes back after a long time learns that the document has the
	// operation that it sends again.
	operationRowsKept = 7 * 24 * time.Hour
	// DeleteOldOperations changes at most deletedOperations rows in one
	// statement, so that no statement holds its locks for long.
	deletedOperations = 5000
	// An open version gets a new snapshot after snapshotOperations
	// operations, so that no server replays more than about that many.
	snapshotOperations = 500
	// A write or a read goes back at most maxBehind operations. A seq
	// further back is stale.
	maxBehind = 2000
	// The change summary of a version joins at most maxSummaries summaries
	// of its operations.
	maxSummaries = 20
	// The log holds the replacements of a change that is not typing up to
	// maxLoggedChange bytes of text. The pages get a larger change with a
	// load of the document.
	maxLoggedChange = 1 << 20
	// A refused push names about conflictTextRunes characters of the
	// sentence that holds the text that other people changed.
	conflictTextRunes = 80

	// The state cache holds the live state of at most cachedDocuments
	// documents, and at most cachedBytes in all.
	cachedDocuments = 256
	cachedBytes     = 256 << 20
)

// errLogIncomplete says that the log does not hold every operation that a
// replay needs.
var errLogIncomplete = errors.New("the operation log is not complete")

// liveState is the source of a document at a seq, in a version.
type liveState struct {
	versionID string
	seq       int64
	source    []byte
	// sum is the CRC-32 of source, and valid says that source is UTF-8.
	sum   uint32
	valid bool
}

func newLiveState(versionID string, seq int64, source []byte) liveState {
	return liveState{versionID: versionID, seq: seq, source: source, sum: crc32.ChecksumIEEE(source), valid: utf8.Valid(source)}
}

// stateCache holds the live state of the documents used last, so that an
// operation does not read its document from the blob store. It is only a
// cache: every server makes the live state from the blob of the current
// version and the operations after it. A server whose state is behind
// applies the operations that it lacks.
type stateCache struct {
	mu   sync.Mutex
	docs map[string]*list.Element
	// used holds a *cachedDocument for each document, the one used last first.
	used  *list.List
	bytes int
}

type cachedDocument struct {
	id    string
	state liveState
	// summary is the change summary of the open version at state, when
	// summarized is set.
	summary    string
	summarized bool
}

func newStateCache() *stateCache {
	return &stateCache{docs: map[string]*list.Element{}, used: list.New()}
}

// cachedOf returns the document that e, an element of used, holds.
func cachedOf(e *list.Element) *cachedDocument {
	d, _ := e.Value.(*cachedDocument)
	return d
}

func (c *stateCache) get(documentID string) (liveState, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.docs[documentID]
	if e == nil {
		return liveState{}, false
	}
	c.used.MoveToFront(e)
	return cachedOf(e).state, true
}

// put keeps a state of the document, unless the cache has a later one. The
// caller must not put a state that its transaction did not commit.
func (c *stateCache) put(documentID string, state liveState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.docs[documentID]
	if e == nil {
		e = c.used.PushFront(&cachedDocument{id: documentID})
		c.docs[documentID] = e
	}
	c.used.MoveToFront(e)
	d := cachedOf(e)
	if d.state.seq > state.seq {
		return
	}
	c.bytes += len(state.source) - len(d.state.source)
	d.summarized = d.summarized && d.state.versionID == state.versionID && d.state.seq == state.seq
	d.state = state
	// The documents used least recently go first.
	for c.used.Len() > 1 && (c.used.Len() > cachedDocuments || c.bytes > cachedBytes) {
		last := cachedOf(c.used.Back())
		c.used.Remove(c.used.Back())
		delete(c.docs, last.id)
		c.bytes -= len(last.state.source)
	}
}

// summary returns the change summary of the open version at state, which
// describe makes. It keeps the summary while it holds that state, so many
// reads of History cost one summary for each seq.
func (c *stateCache) summary(documentID string, state liveState, describe func() (string, error)) (string, error) {
	// held returns the cached document when its state is state.
	held := func() *cachedDocument {
		if e := c.docs[documentID]; e != nil {
			if d := cachedOf(e); d.state.versionID == state.versionID && d.state.seq == state.seq {
				return d
			}
		}
		return nil
	}
	c.mu.Lock()
	d := held()
	if d != nil && d.summarized {
		defer c.mu.Unlock()
		return d.summary, nil
	}
	c.mu.Unlock()
	summary, err := describe()
	c.mu.Lock()
	defer c.mu.Unlock()
	if d := held(); d != nil && err == nil {
		d.summary, d.summarized = summary, true
	}
	return summary, err
}

// live is a document as one read gives it: the seq of the live document,
// and the current version. A write holds the row of the document locked.
type live struct {
	id      string
	seq     int64
	version dbsqlc.GetLiveVersionRow
}

// replaced returns key, a blob of the version of doc, which a write
// replaces: it is of no use after the commit. It returns "" for the blob of
// the version before, which stays.
func (doc live) replaced(key string) string {
	if key == doc.version.ParentBlobKey {
		return ""
	}
	return key
}

func liveOf(v dbsqlc.GetLiveVersionRow) live {
	return live{id: v.DocumentID, seq: v.DocumentSeq, version: v}
}

// lock makes the writes to the live document and the approval writes on a
// document take turns: each of them holds the row of the document from this
// call to the end of its transaction. So the operations of a document have
// one order on all servers, and the status that an approval change records
// counts all changes before it. lock returns the current version.
func lock(ctx context.Context, q *dbsqlc.Queries, documentID string) (string, error) {
	current, err := q.LockDocument(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", repo.ErrNotFound
	}
	return current, err
}

// lockLive locks the document (lock), and reads it.
func lockLive(ctx context.Context, q *dbsqlc.Queries, documentID string) (live, error) {
	current, err := lock(ctx, q, documentID)
	if err != nil {
		return live{}, err
	}
	v, err := q.GetLiveVersion(ctx, current)
	return liveOf(v), err
}

// view reads the document and its live state with no lock. A write after
// the read can seal the version or move its snapshot, and delete the blob
// that the read needs. So a read that fails goes again while the version or
// its blob moves. When they did not move, the error is real.
func (s *Store) view(ctx context.Context, documentID string) (doc live, state liveState, err error) {
	if doc, err = s.read(ctx, documentID); err != nil {
		return doc, state, err
	}
	for {
		if state, err = s.current(ctx, s.q, doc); err == nil {
			return doc, state, nil
		}
		again, readErr := s.read(ctx, documentID)
		if readErr != nil {
			return again, state, readErr
		}
		if again.version.ID == doc.version.ID && again.version.HtmlBlobKey == doc.version.HtmlBlobKey {
			return doc, state, err
		}
		doc = again
	}
}

// read reads the document with no lock. One statement gives the seq of the
// document and its current version. With two statements, a seal between
// them gives the content of a later seq as that of an earlier one, and a
// server then applies an operation to its cached state a second time.
func (s *Store) read(ctx context.Context, documentID string) (live, error) {
	v, err := s.q.GetLiveDocument(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return live{}, repo.ErrNotFound
	}
	return liveOf(dbsqlc.GetLiveVersionRow(v)), err
}

// logged returns the operations of the document after one seq, up to
// another, in order, with the sum of the source after the last one. Each
// operation is the replacements on the source before it. It returns
// errLogIncomplete when the log does not hold them all.
func logged(ctx context.Context, q *dbsqlc.Queries, documentID string, after, to int64) ([][]textedit.Replacement, uint32, error) {
	rows, err := q.ListOperations(ctx, dbsqlc.ListOperationsParams{DocumentID: documentID, AfterSeq: after, ToSeq: to})
	if err != nil {
		return nil, 0, err
	}
	if int64(len(rows)) != to-after {
		return nil, 0, errLogIncomplete
	}
	ops := make([][]textedit.Replacement, len(rows))
	var sum uint32
	for i, row := range rows {
		if row.Replacements == nil {
			return nil, 0, errLogIncomplete
		}
		if err := json.Unmarshal(row.Replacements, &ops[i]); err != nil {
			return nil, 0, err
		}
		sum = row.Sum
	}
	return ops, sum, nil
}

// replay applies the operations to source, in order. A Rope copies the
// source only now and then, so a long replay costs far less than one copy
// of the source for each operation.
func replay(source []byte, ops [][]textedit.Replacement) ([]byte, error) {
	state := textedit.NewRope(source)
	for _, op := range ops {
		if err := state.Patch(op); err != nil {
			// The log is wrong, which is not the fault of a caller.
			return nil, fmt.Errorf("an operation of the log does not fit the state before it: %v", err)
		}
	}
	return state.Bytes(), nil
}

// rewind takes the operations back from source, the state after them.
func rewind(source []byte, ops [][]textedit.Replacement) (*textedit.Rope, error) {
	state := textedit.NewRope(source)
	for i := len(ops) - 1; i >= 0; i-- {
		if err := state.Patch(textedit.Invert(ops[i])); err != nil {
			return nil, fmt.Errorf("an operation of the log does not fit the state after it: %v", err)
		}
	}
	return state, nil
}

// current returns the live state of doc. It starts from the cached state of
// the same version, and applies the operations that the cache lacks. Else
// it reads the blob of the version, and the operations after the snapshot
// of an open version. It reads only what is committed, so a transaction
// calls it before it writes.
func (s *Store) current(ctx context.Context, q *dbsqlc.Queries, doc live) (liveState, error) {
	// A state from rows that do not agree must not go into the cache.
	if !doc.version.Current || doc.version.Seq > doc.seq {
		return liveState{}, fmt.Errorf("version %s at seq %d is not the live document at seq %d", doc.version.ID, doc.version.Seq, doc.seq)
	}
	if state, ok, err := s.cachedState(ctx, q, doc); ok || err != nil {
		return state, err
	}
	// The row names the blob, so a blob that is not there is not a document
	// that is gone.
	source, _, err := s.blobs.Get(ctx, doc.version.HtmlBlobKey)
	if err != nil {
		return liveState{}, fmt.Errorf("the content of version %s: %w", doc.version.ID, err)
	}
	if doc.version.Open {
		ops, _, err := logged(ctx, q, doc.id, doc.version.Seq, doc.seq)
		if err != nil {
			return liveState{}, err
		}
		if source, err = replay(source, ops); err != nil {
			return liveState{}, err
		}
	}
	state := newLiveState(doc.version.ID, doc.seq, source)
	s.states.put(doc.id, state)
	return state, nil
}

// cachedState returns the cached state of the version of doc, with the
// operations that the cache lacks. It returns false when the cache has no
// earlier state of the version, or when the log does not hold those
// operations.
func (s *Store) cachedState(ctx context.Context, q *dbsqlc.Queries, doc live) (liveState, bool, error) {
	cached, ok := s.states.get(doc.id)
	if !ok || cached.versionID != doc.version.ID || cached.seq > doc.seq {
		return liveState{}, false, nil
	}
	if cached.seq == doc.seq {
		return cached, true, nil
	}
	ops, sum, err := logged(ctx, q, doc.id, cached.seq, doc.seq)
	if errors.Is(err, errLogIncomplete) {
		return liveState{}, false, nil
	}
	if err != nil {
		return liveState{}, false, err
	}
	source, err := replay(cached.source, ops)
	if err != nil {
		return liveState{}, false, err
	}
	state := liveState{versionID: doc.version.ID, seq: doc.seq, source: source, sum: sum, valid: utf8.Valid(source)}
	s.states.put(doc.id, state)
	return state, true, nil
}

// stateAt returns the source of doc at a seq at or before the live seq:
// the live state, with the operations after seq taken back. It also returns
// those operations. It returns ErrStale when the log does not hold them all,
// or when they are more than maxBehind, which it knows before it reads them.
func stateAt(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, seq int64) (*textedit.Rope, [][]textedit.Replacement, error) {
	switch behind := doc.seq - seq; {
	case behind < 0:
		return nil, nil, repo.ErrNoSuchSeq
	case behind > maxBehind:
		return nil, nil, repo.ErrStale
	}
	ops, _, err := logged(ctx, q, doc.id, seq, doc.seq)
	if errors.Is(err, errLogIncomplete) {
		return nil, nil, repo.ErrStale
	}
	if err != nil {
		return nil, nil, err
	}
	before, err := rewind(state.source, ops)
	return before, ops, err
}

// move is the replacements of a sender on their way over the operations of
// the log after their base. A step costs far less than a copy of the
// document, because the states are Ropes.
type move struct {
	// state is the document with the operations so far, and applied are
	// the replacements as they apply to it, in their one form.
	state   textedit.Rope
	applied []textedit.Replacement
	// source is the source that the sender made, with the operations so
	// far, and others are those operations as they apply to it, in order.
	// It is also state with applied.
	source textedit.Rope
	others [][]textedit.Replacement
	// broken tells whether a step of the move took the replacements out of
	// the places in tags that they had (see textedit.Keeps).
	broken bool
}

// moved starts the move of op, made on the state of doc at its BaseSeq, and
// moves it over the operations of the log up to the seq to. state is the
// live state of doc. It also returns the document at to with the operation.
func moved(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, op repo.Operation, to int64) (*move, []byte, error) {
	base, log, err := stateAt(ctx, q, doc, state, op.BaseSeq)
	if err != nil {
		return nil, nil, err
	}
	applied, err := textedit.Normal(base, op.Replacements)
	if err != nil {
		return nil, nil, err
	}
	m := &move{state: *base, applied: applied, source: *base, others: [][]textedit.Replacement{}}
	if err := m.source.Patch(applied); err != nil {
		return nil, nil, err
	}
	source, err := m.over(log[:to-op.BaseSeq])
	return m, source, err
}

// over moves the replacements over the next operations of the log, and
// returns the document with them. After a move over operations, it makes
// sure that this is also the source that the sender has: the two orders of
// the operations must give one text.
func (m *move) over(log [][]textedit.Replacement) ([]byte, error) {
	for _, op := range log {
		other := textedit.Transform(&m.state, op, m.applied, false)
		m.applied = textedit.Transform(&m.state, m.applied, op, true)
		before := m.state
		if err := m.state.Patch(op); err != nil {
			return nil, fmt.Errorf("an operation of the log does not fit the state before it: %v", err)
		}
		m.broken = m.broken || !textedit.Keeps(&before, op, &m.state, m.applied)
		if err := m.source.Patch(other); err != nil {
			return nil, fmt.Errorf("an operation does not move onto the source of the sender: %v", err)
		}
		m.others = append(m.others, other)
	}
	source := m.source.Bytes()
	if len(m.others) > 0 {
		document := m.state
		if err := document.Patch(m.applied); err != nil {
			return nil, fmt.Errorf("the replacements do not move over the operations: %v", err)
		}
		if !bytes.Equal(document.Bytes(), source) {
			return nil, errors.New("the two orders of the operations give two texts")
		}
	}
	return source, nil
}

// writable reports why the live document does not take the replacements of
// m, or nil.
func (m *move) writable() error {
	// The live document keeps its tags whole: an operation that the move put
	// into a tag, or that leaves a tag that does not end, comes from a fault
	// of a client.
	if m.broken || textedit.Breaks(&m.state, m.applied) {
		return &textedit.ReplacementError{Reason: textedit.ReasonTags}
	}
	// Every state after a typed operation comes from the log.
	if !loggable(m.applied) {
		return &textedit.ReplacementError{Reason: textedit.ReasonInvalid}
	}
	return nil
}

// open makes the next version of doc, with the id id, by author, and moves
// the document to it. Its first snapshot is the content of the version
// before. A version that typing opens goes on with the sitting that a push
// cut a short time before.
func open(ctx context.Context, q *dbsqlc.Queries, doc *live, id string, author auth.Principal, typed bool) error {
	if err := q.InsertOpenVersion(ctx, dbsqlc.InsertOpenVersionParams{ID: id, ParentVersionID: doc.version.ID, CreatedByType: string(author.Type), CreatedByID: author.ID, Seq: doc.seq}); err != nil {
		return err
	}
	if typed {
		if err := q.ContinueSitting(ctx, dbsqlc.ContinueSittingParams{ID: id, IdleSeconds: sealIdleAfter.Seconds()}); err != nil {
			return err
		}
	}
	if err := q.UpdateDocumentCurrentVersion(ctx, dbsqlc.UpdateDocumentCurrentVersionParams{CurrentVersionID: pgtype.Text{String: id, Valid: true}, ID: doc.id}); err != nil {
		return err
	}
	var err error
	doc.version, err = q.GetLiveVersion(ctx, id)
	return err
}

// operation is a row of the log, before it has its seq and its version.
type operation struct {
	author     auth.Principal
	clientOpID string
	typed      bool
	summary    string
	// applied turns the live document into source. It is nil when the log
	// does not hold it.
	applied []textedit.Replacement
	source  []byte
}

// loggable reports whether the log can hold the replacements. It holds them
// as JSON in PostgreSQL, which takes only valid UTF-8 without the NUL
// character. A document from before the live document can have other bytes.
func loggable(rs []textedit.Replacement) bool {
	for _, r := range rs {
		if text := r.OldHTML + r.NewHTML; !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
			return false
		}
	}
	return true
}

// validText makes a change summary text that PostgreSQL takes. A summary
// can quote a document from before the live document, which can have bytes
// that are not UTF-8.
func validText(summary string) string { return strings.ToValidUTF8(summary, "") }

// write adds op to the log of doc, in the current version, which is open,
// and returns the live state after it.
func write(ctx context.Context, q *dbsqlc.Queries, doc *live, op operation) (liveState, error) {
	var applied []byte
	if op.applied != nil {
		var err error
		if applied, err = json.Marshal(op.applied); err != nil {
			return liveState{}, err
		}
	}
	doc.seq++
	state := liveState{versionID: doc.version.ID, seq: doc.seq, source: op.source, sum: crc32.ChecksumIEEE(op.source), valid: true}
	if err := q.InsertOperation(ctx, dbsqlc.InsertOperationParams{
		DocumentID: doc.id, Seq: doc.seq, VersionID: doc.version.ID,
		AuthorType: string(op.author.Type), AuthorID: op.author.ID,
		ClientOpID: pgtype.Text{String: op.clientOpID, Valid: op.clientOpID != ""},
		Typed:      op.typed, Summary: validText(op.summary), Replacements: applied, Sum: state.sum,
	}); err != nil {
		return liveState{}, err
	}
	if err := q.InsertVersionAuthor(ctx, dbsqlc.InsertVersionAuthorParams{VersionID: doc.version.ID, AuthorType: string(op.author.Type), AuthorID: op.author.ID}); err != nil {
		return liveState{}, err
	}
	return state, q.SetDocumentSeq(ctx, dbsqlc.SetDocumentSeqParams{Seq: doc.seq, ID: doc.id})
}

// sealing is the seal of the open version of a document at one seq, made
// with no lock: its content is in a new blob, and its summary and its search
// text are made. A write applies it with the lock (seal).
type sealing struct {
	// discard says that the content is that of the version before: the
	// version is then removed, and not sealed.
	discard                       bool
	key, sha, searchText, summary string
	// restored says that the version restores an earlier version. The event
	// of the seal tells the pages so.
	restored bool
	// replaced is the blob that the seal replaced. It goes after the commit
	// (forget).
	replaced string
}

// sealOf makes the seal of the open version of doc, whose live state is
// state. It makes nothing when the version is sealed.
func (s *Store) sealOf(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState) (sealing, error) {
	switch {
	case !doc.version.Open:
		return sealing{}, nil
	case sha(state.source) == doc.version.ParentSha256:
		return sealing{discard: true}, nil
	}
	summary, err := s.summaryOf(ctx, q, doc, state.source)
	if err != nil {
		return sealing{}, err
	}
	// Each seal has its own blob. Two writes can make the seal of one
	// version at the same time, and the one that does not apply its seal
	// deletes its blob.
	return s.content(ctx, fmt.Sprintf("docs/%s/%s.%s.html", doc.id, doc.version.ID, newID("seal")), state.source, summary)
}

// content writes html, the content of a version, to the blob key, and makes
// the rest of its seal.
func (s *Store) content(ctx context.Context, key string, html []byte, summary string) (sealing, error) {
	if err := s.blobs.Put(ctx, key, htmlContentType, html); err != nil {
		return sealing{}, err
	}
	return sealing{key: key, sha: sha(html), searchText: searchText(html), summary: validText(summary)}, nil
}

// abandon deletes the blobs of seals that no version holds.
func (s *Store) abandon(ctx context.Context, seals ...sealing) {
	for _, p := range seals {
		if p.key != "" {
			_ = s.blobs.Delete(context.WithoutCancel(ctx), p.key)
		}
	}
}

// seal applies ready, the seal of the open version of doc at its seq, and
// stores the document event. It does nothing when the version is sealed.
// The blob of the open version is then of no use, and ready names it.
func (s *Store) seal(ctx context.Context, q *dbsqlc.Queries, doc *live, ready *sealing, actor auth.Principal) error {
	if !doc.version.Open {
		s.abandon(ctx, *ready)
		return nil
	}
	ready.replaced = doc.replaced(doc.version.HtmlBlobKey)
	if ready.discard {
		return s.discard(ctx, q, doc, actor)
	}
	if err := q.SealVersion(ctx, dbsqlc.SealVersionParams{
		ID: doc.version.ID, HtmlBlobKey: ready.key, Sha256: ready.sha, SearchText: ready.searchText,
		ChangeSummary: ready.summary, Seq: doc.seq,
	}); err != nil {
		return err
	}
	doc.version.Open, doc.version.Seq, doc.version.HtmlBlobKey = false, doc.seq, ready.key
	return announce(ctx, q, doc, actor, repo.DocumentPosition{Restored: ready.restored})
}

// summaryOf returns the change summary of the open version of doc with the
// content html: the summaries of its operations, or else what a reader sees
// change from the version before.
func (s *Store) summaryOf(ctx context.Context, q *dbsqlc.Queries, doc live, html []byte) (string, error) {
	summaries, err := q.ListVersionOperationSummaries(ctx, dbsqlc.ListVersionOperationSummariesParams{VersionID: doc.version.ID, RowLimit: maxSummaries})
	if err != nil {
		return "", err
	}
	summary := strings.Join(summaries, "\n")
	if summary == "" {
		before, typed, err := s.sitting(ctx, q, doc.version, html)
		if err != nil {
			return "", err
		}
		summary = textedit.ChangeSummary(before, typed)
	}
	return validText(summary), nil
}

// sitting returns the content before the sitting of the version v, and
// html, the content of v, without the changes of the pushes that cut that
// sitting. A summary of the two says what the people typed.
func (s *Store) sitting(ctx context.Context, q *dbsqlc.Queries, v dbsqlc.GetLiveVersionRow, html []byte) (before, typed []byte, err error) {
	for {
		if before, _, err = s.blobs.Get(ctx, v.ParentBlobKey); err != nil || v.SittingID == "" {
			return before, html, err
		}
		// The version before v is a push, and before is its content. The
		// change from before to html moves over the change that takes the
		// push out.
		push, err := q.GetLiveVersion(ctx, v.ParentVersionID)
		if err != nil {
			return nil, nil, err
		}
		unpushed, _, err := s.blobs.Get(ctx, push.ParentBlobKey)
		if err != nil {
			return nil, nil, err
		}
		typing := textedit.Transform(textedit.Bytes(before), textedit.Between(before, html), textedit.Between(before, unpushed), true)
		if html, err = textedit.Patch(unpushed, typing); err != nil {
			return nil, nil, err
		}
		if v, err = q.GetLiveVersion(ctx, push.ParentVersionID); err != nil {
			return nil, nil, err
		}
	}
}

// LiveChangeSummary returns the open version of the document and the change
// summary that a seal gives it now. A sitting that is on the text where it
// started has no summary: a seal discards it. It returns no version when
// the current version is sealed.
func (s *Store) LiveChangeSummary(ctx context.Context, documentID string) (versionID, summary string, err error) {
	doc, state, err := s.view(ctx, documentID)
	if err != nil || !doc.version.Open {
		return "", "", err
	}
	summary, err = s.states.summary(documentID, state, func() (string, error) {
		if sha(state.source) == doc.version.ParentSha256 {
			return "", nil
		}
		return s.summaryOf(ctx, s.q, doc, state.source)
	})
	return doc.version.ID, summary, err
}

// discard removes the open version of doc, whose content is that of the
// version before, and makes that version the current one again. The seq of
// the document stays. The operations stay in the log as operations of the
// version before, so a page that is behind still follows by seq, and the
// comments made on the version stay too. The approvals of the version
// before count again, because it is the current version, and the approval
// event says so.
func (s *Store) discard(ctx context.Context, q *dbsqlc.Queries, doc *live, actor auth.Principal) error {
	if err := q.LockVersion(ctx, doc.version.ID); err != nil {
		return err
	}
	if err := q.DiscardOpenVersion(ctx, dbsqlc.DiscardOpenVersionParams{ID: doc.version.ID, ParentVersionID: doc.version.ParentVersionID}); err != nil {
		return err
	}
	var err error
	if doc.version, err = q.GetLiveVersion(ctx, doc.version.ParentVersionID); err != nil {
		return err
	}
	if err := announce(ctx, q, doc, actor, repo.DocumentPosition{}); err != nil {
		return err
	}
	return s.recordApprovalEvent(ctx, q, approvalEvent{documentID: doc.id, kind: repo.ApprovalEventVersionCreated, actor: actor})
}

// unlockedTries is the number of times that a write does its slow work with
// no lock before it does that work with the lock.
const unlockedTries = 3

// lockAfter does the slow work of a write, prepare, on the document as view
// gives it, and then locks the document in a new transaction. When an
// operation or another write came during that work, it lets the lock go and
// does all of the work again, on the new state. (AppendOperation does not:
// it moves its work over the late operations.) The last try does the work
// with the lock, so that people who type all the time do not hold the write
// back. prepare gets the queries to read with.
func (s *Store) lockAfter(ctx context.Context, documentID string, prepare func(q *dbsqlc.Queries, doc live, state liveState) error) (pgx.Tx, live, error) {
	for try := 1; ; try++ {
		seen, state, err := s.view(ctx, documentID)
		if err == nil {
			err = prepare(s.q, seen, state)
		}
		if err != nil {
			return nil, live{}, err
		}
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return nil, live{}, err
		}
		q := s.q.WithTx(tx)
		doc, err := lockLive(ctx, q, documentID)
		if err == nil && (doc.seq != seen.seq || doc.version.ID != seen.version.ID) {
			if try < unlockedTries {
				rollback(ctx, tx)
				continue
			}
			if state, err = s.current(ctx, q, doc); err == nil {
				err = prepare(q, doc, state)
			}
		}
		if err != nil {
			rollback(ctx, tx)
			return nil, live{}, err
		}
		return tx, doc, nil
	}
}

// commitSeals commits tx, a write that makes seals. It also reports whether
// the blobs of those seals stay: after a commit, and after an error that can
// come when the commit is there, as a lost connection. The server refused a
// commit that gives a PgError, so its seals are in no version, and their
// blobs go.
func commitSeals(ctx context.Context, tx pgx.Tx) (kept bool, err error) {
	err = tx.Commit(ctx)
	var pgErr *pgconn.PgError
	refused := errors.Is(err, pgx.ErrTxCommitRollback) || errors.As(err, &pgErr)
	return !refused, err
}

// forget deletes the blobs that the seals of a committed write replaced.
func (s *Store) forget(ctx context.Context, seals ...sealing) {
	for _, p := range seals {
		if p.replaced != "" {
			_ = s.blobs.Delete(context.WithoutCancel(ctx), p.replaced)
		}
	}
}

// snapshot writes source, the live document at the seq of doc, as the new
// snapshot of its open version. It runs after the commit of an operation.
// The blob is written with no lock. The update locks the document, so that
// no write reads a snapshot that goes, and makes sure that the version is
// still open and has no later snapshot. A snapshot that fails is only
// logged: the one before still serves.
func (s *Store) snapshot(ctx context.Context, doc live, source []byte) {
	ctx = context.WithoutCancel(ctx)
	key := fmt.Sprintf("docs/%s/%s.%d.html", doc.id, doc.version.ID, doc.seq)
	replaced, err := s.moveSnapshot(ctx, doc, key, source)
	if err != nil {
		slog.WarnContext(ctx, "version snapshot failed", slog.String("document_id", doc.id), slog.String("version_id", doc.version.ID), slog.Any("error", err))
	}
	s.forget(ctx, sealing{replaced: doc.replaced(replaced)})
}

// moveSnapshot returns the blob that is of no use after it: the snapshot
// before, or the new one when the version did not take it. It returns no
// blob when the commit gives an error: the version can then name the one
// or the other.
func (s *Store) moveSnapshot(ctx context.Context, doc live, key string, source []byte) (string, error) {
	if err := s.blobs.Put(ctx, key, htmlContentType, source); err != nil {
		return key, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return key, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := lock(ctx, q, doc.id); err != nil {
		return key, err
	}
	replaced, err := q.SnapshotVersion(ctx, dbsqlc.SnapshotVersionParams{ID: doc.version.ID, HtmlBlobKey: key, Seq: doc.seq})
	if errors.Is(err, pgx.ErrNoRows) {
		return key, nil
	}
	if err != nil {
		return key, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return replaced, nil
}

// announce stores the document event of a version that opened or was sealed,
// in the transaction of that write. event tells the rest: that the write was
// typed, or that it restores an earlier version.
func announce(ctx context.Context, q *dbsqlc.Queries, doc *live, actor auth.Principal, event repo.DocumentPosition) error {
	event.Seq, event.VersionID, event.Sealed = doc.seq, doc.version.ID, !doc.version.Open
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return appendDocumentEvent(ctx, q, doc.id, repo.DocumentEventDocument, data, actor)
}

func versionBlobKey(documentID, versionID string) string {
	return fmt.Sprintf("docs/%s/%s.html", documentID, versionID)
}

func (s *Store) AppendOperation(ctx context.Context, documentID string, op repo.Operation, author auth.Principal) (repo.OperationResult, error) {
	sent := dbsqlc.GetOperationByClientIDParams{DocumentID: documentID, ClientOpID: pgtype.Text{String: op.ClientOpID, Valid: true}}
	if first, err := s.q.GetOperationByClientID(ctx, sent); err == nil {
		return s.repeated(ctx, documentID, op, first)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return repo.OperationResult{}, err
	}
	seen, m, source, err := s.draft(ctx, documentID, op)
	if err != nil {
		return repo.OperationResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.OperationResult{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	doc, err := lockLive(ctx, q, documentID)
	if err != nil {
		return repo.OperationResult{}, err
	}
	// Another attempt wrote the operation during that work.
	if first, err := q.GetOperationByClientID(ctx, sent); err == nil {
		rollback(ctx, tx)
		return s.repeated(ctx, documentID, op, first)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return repo.OperationResult{}, err
	}
	// Only the operations that came during the draft are left.
	if source, err = m.late(ctx, q, doc, seen.seq, source); err != nil {
		return repo.OperationResult{}, err
	}
	if len(source) > repo.MaxHTMLBytes {
		return repo.OperationResult{}, repo.ErrTooLarge
	}
	if err := m.writable(); err != nil {
		return repo.OperationResult{}, err
	}
	opened := !doc.version.Open
	next, err := s.typed(ctx, q, &doc, operation{author: author, clientOpID: op.ClientOpID, typed: true, summary: op.Summary, applied: m.applied, source: source})
	if err != nil {
		return repo.OperationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.OperationResult{}, err
	}
	s.states.put(documentID, next)
	if doc.seq-doc.version.Seq >= snapshotOperations {
		s.snapshot(ctx, doc, source)
	}
	return repo.OperationResult{Seq: doc.seq, VersionID: doc.version.ID, Others: m.others, Sum: next.sum, Applied: m.applied, Announced: opened}, nil
}

// draft does the work of op that grows with the document and with the log,
// before the lock, on the document as it is now. It returns the document as
// it read it, the move of op up to its seq, and the document with op.
func (s *Store) draft(ctx context.Context, documentID string, op repo.Operation) (live, *move, []byte, error) {
	seen, state, err := s.view(ctx, documentID)
	if err != nil {
		return seen, nil, nil, err
	}
	if !state.valid {
		return seen, nil, nil, repo.ErrNotUTF8
	}
	m, source, err := moved(ctx, s.q, seen, state, op, seen.seq)
	return seen, m, source, err
}

// late moves m over the operations of doc after the seq seen, which came
// during the work before the lock, and returns the document with them.
// source is the document at seen with m.
func (m *move) late(ctx context.Context, q *dbsqlc.Queries, doc live, seen int64, source []byte) ([]byte, error) {
	if doc.seq-seen > maxBehind {
		return nil, repo.ErrStale
	}
	late, _, err := logged(ctx, q, doc.id, seen, doc.seq)
	if errors.Is(err, errLogIncomplete) {
		return nil, repo.ErrStale
	}
	if err != nil || len(late) == 0 {
		return source, err
	}
	return m.over(late)
}

// typed writes op, a typed operation, to the log of doc. When the version
// of doc is sealed, it first opens a new version. A new version has no
// approvals, so its events go out when it opens.
func (s *Store) typed(ctx context.Context, q *dbsqlc.Queries, doc *live, op operation) (liveState, error) {
	opened := !doc.version.Open
	if opened {
		if err := open(ctx, q, doc, newID("ver"), op.author, true); err != nil {
			return liveState{}, err
		}
	}
	next, err := write(ctx, q, doc, op)
	if err != nil || !opened {
		return next, err
	}
	if err := announce(ctx, q, doc, op.author, repo.DocumentPosition{Typed: true}); err != nil {
		return liveState{}, err
	}
	return next, s.recordApprovalEvent(ctx, q, approvalEvent{documentID: doc.id, kind: repo.ApprovalEventVersionCreated, actor: op.author})
}

// repeated returns the answer of the first attempt of op, which the log
// holds as first. The answer has the operations that were before the first
// attempt. When the log no longer gives them, or no longer gives the
// replacements of first, it returns ErrApplied: the document has the
// operation, and the sender gets the live document.
func (s *Store) repeated(ctx context.Context, documentID string, op repo.Operation, first dbsqlc.GetOperationByClientIDRow) (repo.OperationResult, error) {
	out := repo.OperationResult{Seq: first.Seq, VersionID: first.VersionID, Others: [][]textedit.Replacement{}, Sum: first.Sum, Repeated: true}
	if !first.Held {
		return repo.OperationResult{}, repo.ErrApplied
	}
	if first.Seq-1 <= op.BaseSeq {
		return out, nil
	}
	doc, state, err := s.view(ctx, documentID)
	if err != nil {
		return repo.OperationResult{}, err
	}
	m, _, err := moved(ctx, s.q, doc, state, op, first.Seq-1)
	if errors.Is(err, repo.ErrStale) {
		err = repo.ErrApplied
	}
	if err != nil {
		return repo.OperationResult{}, err
	}
	out.Others = m.others
	return out, nil
}

func (s *Store) ChangesAfter(ctx context.Context, documentID string, after int64) (repo.DocumentChanges, error) {
	doc, state, err := s.view(ctx, documentID)
	if err != nil {
		return repo.DocumentChanges{}, err
	}
	if after < 0 || after > doc.seq {
		return repo.DocumentChanges{}, repo.ErrNoSuchSeq
	}
	// The seqs have no gaps, so the count of the operations is known before
	// the read.
	if doc.seq-after > maxBehind {
		return repo.DocumentChanges{}, repo.ErrStale
	}
	rows, err := s.q.ListOperations(ctx, dbsqlc.ListOperationsParams{DocumentID: documentID, AfterSeq: after, ToSeq: doc.seq})
	if err != nil {
		return repo.DocumentChanges{}, err
	}
	out := repo.DocumentChanges{Seq: doc.seq, VersionID: doc.version.ID, Ops: make([]json.RawMessage, len(rows)), Typed: true, Sum: state.sum}
	for i, row := range rows {
		// The log does not hold a very large change, or it is deleted.
		if row.Replacements == nil {
			return repo.DocumentChanges{}, repo.ErrStale
		}
		out.Ops[i] = row.Replacements
	}
	if int64(len(rows)) != doc.seq-after {
		return repo.DocumentChanges{}, repo.ErrStale
	}
	authors, err := s.q.ListOperationAuthorsAfter(ctx, dbsqlc.ListOperationAuthorsAfterParams{DocumentID: documentID, AfterSeq: after, ToSeq: doc.seq})
	if err != nil {
		return repo.DocumentChanges{}, err
	}
	out.Authors = make([]auth.Principal, 0, len(authors))
	for _, r := range authors {
		out.Authors = append(out.Authors, auth.Principal{Type: auth.PrincipalType(r.AuthorType), ID: r.AuthorID, Email: r.AuthorEmail, Name: r.AuthorName, PictureURL: r.AuthorPictureUrl})
		out.Typed = out.Typed && r.Typed
	}
	return out, nil
}

// SealIdleVersions seals the open versions in which the typing stopped long
// ago, and the open versions that are not the current one of their
// document. Each one is sealed as its creator, in its own transaction, which
// locks its document. So all servers can run it at the same time. A version
// that cannot be sealed is logged, and does not stop the others.
// SealIdleVersions returns the number of versions that it sealed.
func (s *Store) SealIdleVersions(ctx context.Context) (sealed int, err error) {
	var seen []string
	for ctx.Err() == nil {
		documentID, done, err := s.sealIdleVersion(ctx, seen)
		switch {
		case documentID == "":
			return sealed, err
		case err != nil:
			slog.ErrorContext(ctx, "sealing a version failed", slog.String("document_id", documentID), slog.Any("error", err))
		case done:
			sealed++
		}
		seen = append(seen, documentID)
	}
	return sealed, ctx.Err()
}

// sealIdleVersion seals one version, and returns its document, and whether
// it sealed it. It returns no document when no version is ready, or when it
// cannot look for one. The seal is made before the lock. With the lock, the
// version must still be at that seq, and its last operation must still be
// old: the search does not see an operation that came during it.
func (s *Store) sealIdleVersion(ctx context.Context, skipped []string) (string, bool, error) {
	idle, err := s.q.GetIdleVersion(ctx, dbsqlc.GetIdleVersionParams{Skipped: skipped, IdleSeconds: sealIdleAfter.Seconds()})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	var seen live
	var ready sealing
	reached := false
	defer func() {
		if !reached {
			s.abandon(ctx, ready)
		}
	}()
	if idle.Current {
		if seen, ready, err = s.idleSeal(ctx, idle.DocumentID, idle.VersionID); err != nil {
			return idle.DocumentID, false, err
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return idle.DocumentID, false, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	doc, err := lockLive(ctx, q, idle.DocumentID)
	if err != nil {
		return idle.DocumentID, false, err
	}
	switch {
	case !idle.Current:
		// A server of the release before saved a version over this one. Its
		// blob, the last snapshot, is its content.
		err = q.SealStrayVersion(ctx, idle.VersionID)
	default:
		var quiet bool
		if quiet, err = stillIdle(ctx, q, doc, seen, idle.VersionID); err != nil || !quiet {
			return idle.DocumentID, false, err
		}
		creator := auth.Principal{Type: auth.PrincipalType(doc.version.CreatedByType), ID: doc.version.CreatedByID}
		err = s.seal(ctx, q, &doc, &ready, creator)
	}
	if err != nil {
		return idle.DocumentID, false, err
	}
	if reached, err = commitSeals(ctx, tx); err != nil {
		return idle.DocumentID, false, err
	}
	s.forget(ctx, ready)
	return idle.DocumentID, true, nil
}

// idleSeal reads the document with no lock, and makes the seal of its
// current version when that is the version versionID.
func (s *Store) idleSeal(ctx context.Context, documentID, versionID string) (live, sealing, error) {
	seen, state, err := s.view(ctx, documentID)
	if err != nil || seen.version.ID != versionID {
		return seen, sealing{}, err
	}
	ready, err := s.sealOf(ctx, s.q, seen, state)
	return seen, ready, err
}

// stillIdle says whether doc, which the caller locked, is still as the
// caller saw it, in the version versionID, and whether its last operation is
// still old.
func stillIdle(ctx context.Context, q *dbsqlc.Queries, doc, seen live, versionID string) (bool, error) {
	if seen.version.ID != versionID || doc.version.ID != versionID || doc.seq != seen.seq {
		return false, nil
	}
	return q.IsDocumentIdle(ctx, dbsqlc.IsDocumentIdleParams{DocumentID: doc.id, Seq: doc.seq, IdleSeconds: sealIdleAfter.Seconds()})
}

// DeleteOldOperations takes the replacements out of the operations of the
// versions that were sealed more than operationsKept ago, and deletes the
// operations that are older than operationRowsKept. Each statement changes
// a batch. It returns the number of operations of each kind.
func (s *Store) DeleteOldOperations(ctx context.Context) (emptied, deleted int, err error) {
	if emptied, err = batches(func() (int64, error) {
		return s.q.EmptyOldOperations(ctx, dbsqlc.EmptyOldOperationsParams{MaxAgeSeconds: operationsKept.Seconds(), RowLimit: deletedOperations})
	}); err != nil {
		return emptied, 0, err
	}
	deleted, err = batches(func() (int64, error) {
		return s.q.DeleteOldOperations(ctx, dbsqlc.DeleteOldOperationsParams{MaxAgeSeconds: operationRowsKept.Seconds(), RowLimit: deletedOperations})
	})
	return emptied, deleted, err
}

// batches runs batch, which changes at most deletedOperations rows and
// returns their number, until no row is left. It returns the number of all
// rows.
func batches(batch func() (int64, error)) (rows int, err error) {
	for {
		n, err := batch()
		rows += int(n)
		if err != nil || n < deletedOperations {
			return rows, err
		}
	}
}

func (s *Store) SaveVersion(ctx context.Context, documentID, baseVersionID string, baseSeq *int64, author auth.Principal, change repo.VersionChange) (repo.Version, repo.SavedOn, error) {
	return s.save(ctx, documentID, baseVersionID, baseSeq, author, change, false)
}

func (s *Store) RestoreVersion(ctx context.Context, documentID string, html []byte, summary string, author auth.Principal) (repo.Version, repo.SavedOn, error) {
	return s.save(ctx, documentID, "", nil, author, repo.Upload(html, summary), true)
}

// save is SaveVersion. restored says that the change restores an earlier
// version.
func (s *Store) save(ctx context.Context, documentID, baseVersionID string, baseSeq *int64, author auth.Principal, change repo.VersionChange, restored bool) (v repo.Version, onto repo.SavedOn, err error) {
	// The change, and the seals of the open version and of the version that
	// the change makes, read and write blobs and grow with the document.
	// lockAfter does them before the lock, on the document as it is now. It
	// does them with the lock only when people typed during three tries.
	id := newID("ver")
	var c pushed
	var closed, made sealing
	reached := false
	defer func() {
		if !reached {
			s.abandon(ctx, closed, made)
		}
	}()
	tx, doc, err := s.lockAfter(ctx, documentID, func(q *dbsqlc.Queries, doc live, state liveState) (err error) {
		s.abandon(ctx, closed, made)
		closed, made = sealing{}, sealing{}
		if c, err = s.changeOn(ctx, q, doc, state, baseVersionID, baseSeq, change); err != nil || c.unchanged {
			return err
		}
		closed, made, err = s.sealsOf(ctx, q, doc, state, id, c)
		return err
	})
	if err != nil {
		return v, onto, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if c.unchanged {
		rollback(ctx, tx)
		// The version is gone when it was a sitting that changed nothing.
		if v, err = s.GetVersion(ctx, c.versionID); errors.Is(err, repo.ErrNotFound) {
			v, err = repo.Version{ID: c.versionID, DocumentID: documentID}, nil
		}
		v.Seq, v.SHA256 = c.seq, sha(c.html)
		return v, repo.SavedOn{VersionID: v.ID, Unchanged: true}, err
	}
	c.applied = loggedChange(c.applied)
	if err := s.seal(ctx, q, &doc, &closed, author); err != nil {
		return v, onto, err
	}
	saved := repo.SavedOn{VersionID: doc.version.ID, Rebased: c.rebased}
	if err := open(ctx, q, &doc, id, author, false); err != nil {
		return v, onto, err
	}
	next, err := write(ctx, q, &doc, operation{author: author, summary: c.summary, applied: c.applied, source: c.html})
	if err != nil {
		return v, onto, err
	}
	made.restored = restored
	if err := s.seal(ctx, q, &doc, &made, author); err != nil {
		return v, onto, err
	}
	if err := s.recordApprovalEvent(ctx, q, approvalEvent{documentID: documentID, kind: repo.ApprovalEventVersionCreated, actor: author}); err != nil {
		return v, onto, err
	}
	if reached, err = commitSeals(ctx, tx); err != nil {
		return v, onto, err
	}
	s.states.put(documentID, next)
	s.forget(ctx, closed, made)
	created := pgTimeRFC3339(doc.version.CreatedAt)
	return repo.Version{
		ID: doc.version.ID, Number: int(doc.version.Number), DocumentID: documentID, CreatedBy: author,
		ChangeSummary: made.summary, SHA256: made.sha, CreatedAt: created, EditedAt: created,
		Authors: []auth.Principal{author}, Seq: doc.seq,
	}, saved, nil
}

// sealsOf makes the seals of a save of c on doc, whose live state is state:
// closed seals the open version, and made seals the version id, which holds
// c. On an error, closed can hold a blob.
func (s *Store) sealsOf(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, id string, c pushed) (closed, made sealing, err error) {
	if len(c.html) > repo.MaxHTMLBytes {
		return closed, made, repo.ErrTooLarge
	}
	if closed, err = s.sealOf(ctx, q, doc, state); err != nil {
		return closed, made, err
	}
	// The version before the new one has the live document as its
	// content, so a change with no summary is described from it.
	summary := c.summary
	if summary == "" {
		summary = textedit.ChangeSummary(state.source, c.html)
	}
	made, err = s.content(ctx, versionBlobKey(doc.id, id), c.html, summary)
	return closed, made, err
}

// loggedChange returns applied when the log holds it, else nil. A page that
// is behind gets a large change with a load of the document.
func loggedChange(applied []textedit.Replacement) []textedit.Replacement {
	size := 0
	for _, r := range applied {
		size += len(r.OldHTML) + len(r.NewHTML)
	}
	if size > maxLoggedChange || !loggable(applied) {
		return nil
	}
	return applied
}

// pushed is a change that is not typing, made on the document as one read
// gives it.
type pushed struct {
	// applied turns the live document into html, and summary names the
	// change.
	applied []textedit.Replacement
	html    []byte
	summary string
	// rebased says that the document had operations after the base of the
	// change.
	rebased bool
	// unchanged says that the change changes nothing. html, the content
	// that the caller has, is then the document at seq, in the version
	// versionID. That is the live document only when html is the live
	// document. Else it is the base of the caller: with a later seq as the
	// base of its next change, that change takes out the text that people
	// typed up to that seq.
	unchanged bool
	versionID string
	seq       int64
}

// changeOn makes the change of a SaveVersion on doc, whose live state is
// state.
func (s *Store) changeOn(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, versionID string, seq *int64, change repo.VersionChange) (pushed, error) {
	base, err := s.baseOf(ctx, q, doc, state, versionID, seq)
	if err != nil {
		return pushed{}, err
	}
	html, summary, err := change(base.source)
	if err != nil {
		return pushed{}, err
	}
	if !utf8.Valid(html) {
		return pushed{}, repo.ErrNotUTF8
	}
	// Content that is the live document changes nothing, whatever its base
	// is: its author sends again a push whose answer was lost.
	if bytes.Equal(html, state.source) {
		return pushed{unchanged: true, html: html, versionID: doc.version.ID, seq: doc.seq}, nil
	}
	applied := textedit.Between(base.source, html)
	if len(applied) == 0 {
		return pushed{unchanged: true, html: html, versionID: base.versionID, seq: base.seq}, nil
	}
	c := pushed{applied: applied, html: html, summary: summary, rebased: len(base.log) > 0}
	// With no operation after the base, the version holds exactly html.
	if c.rebased {
		c.applied, c.html, err = onLive(doc, base, applied)
	}
	return c, err
}

// baseState is the state that the caller of SaveVersion made its change on.
type baseState struct {
	// versionID and seq name the state, as the caller named it.
	versionID string
	seq       int64
	source    []byte
	// log holds the operations of the document after the state.
	log [][]textedit.Replacement
}

// baseOf returns the state that the caller of SaveVersion made its change
// on. state is the live state of doc. The caller names its base as a
// version and a seq:
//
//   - No version: the live document.
//   - A sealed version, with no seq or with a seq that is not before the seq
//     of the version: the content of the version. A read of a sealed version
//     gives such a seq. A version from before the log has seq 0, as its
//     reads do.
//   - A version with a seq before its own: the state at that seq, from the
//     log. The caller read the version while it was open, and people typed
//     more before its seal, or type now. The content of the version is then
//     not what the caller has: with it as the base, the change takes out
//     the text that people typed after that seq.
//   - A version that is not there, with a seq: the state at that seq. The
//     caller read a sitting that changed nothing in the end, and its version
//     was discarded.
//
// It returns ErrBaseVersion for a version of another document, or one that
// is not there with no seq. It returns ErrEditing for the open version with
// no seq, and ErrStale for a seq that is before the version or that the log
// no longer has.
func (s *Store) baseOf(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, versionID string, seq *int64) (baseState, error) {
	if versionID == "" {
		return liveBase(doc, state), nil
	}
	v := doc.version
	if versionID != v.ID {
		var err error
		switch v, err = q.GetLiveVersion(ctx, versionID); {
		case errors.Is(err, pgx.ErrNoRows) && seq != nil:
			return seqBase(ctx, q, doc, state, versionID, *seq)
		case errors.Is(err, pgx.ErrNoRows) || err == nil && v.DocumentID != doc.id:
			return baseState{}, repo.ErrBaseVersion
		case err != nil:
			return baseState{}, err
		}
	}
	return s.versionBase(ctx, q, doc, state, v, seq)
}

// liveBase returns the live state of doc as a base.
func liveBase(doc live, state liveState) baseState {
	return baseState{versionID: doc.version.ID, seq: doc.seq, source: state.source}
}

// versionBase returns the base in v, a version of doc that the caller
// names, at seq.
func (s *Store) versionBase(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, v dbsqlc.GetLiveVersionRow, seq *int64) (baseState, error) {
	switch content := !v.Open && (seq == nil || *seq >= v.Seq); {
	case content && v.Current:
		return liveBase(doc, state), nil
	case content:
		return s.contentBase(ctx, q, doc, state, v)
	case seq == nil:
		return baseState{}, repo.ErrEditing
	case *seq < v.ParentSeq:
		return baseState{}, repo.ErrStale
	}
	return seqBase(ctx, q, doc, state, v.ID, *seq)
}

// seqBase returns the state of doc at seq, which the caller read in the
// version versionID.
func seqBase(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, versionID string, seq int64) (baseState, error) {
	source, log, err := stateAt(ctx, q, doc, state, seq)
	if errors.Is(err, repo.ErrNoSuchSeq) {
		err = repo.ErrStale
	}
	if err != nil {
		return baseState{}, err
	}
	return baseState{versionID: versionID, seq: seq, source: source.Bytes(), log: log}, nil
}

// contentBase returns the content of v, a version before the current one.
// When the log does not go back to that content, one change stands for all
// that people did after it.
func (s *Store) contentBase(ctx context.Context, q *dbsqlc.Queries, doc live, state liveState, v dbsqlc.GetLiveVersionRow) (baseState, error) {
	content, _, err := s.blobs.Get(ctx, v.HtmlBlobKey)
	if err != nil {
		return baseState{}, err
	}
	base := baseState{versionID: v.ID, seq: v.Seq, source: content}
	at, err := seqBase(ctx, q, doc, state, v.ID, v.Seq)
	switch {
	case err == nil && bytes.Equal(at.source, content):
		base.log = at.log
	case err != nil && !errors.Is(err, repo.ErrStale):
		return baseState{}, err
	default:
		if since := textedit.Between(content, state.source); len(since) > 0 {
			base.log = [][]textedit.Replacement{since}
		}
	}
	return base, nil
}

// onLive moves applied, a change of base, over the operations of the log
// after base. It returns the change as it applies to the live document, and
// the document with it. The change must not change text that one of the
// operations changed: that text stays, and onLive returns a
// *VersionConflictError that names it.
func onLive(doc live, base baseState, applied []textedit.Replacement) ([]textedit.Replacement, []byte, error) {
	state := textedit.NewRope(base.source)
	for _, op := range base.log {
		if i := textedit.Touching(state, applied, op); i >= 0 {
			return nil, nil, &repo.VersionConflictError{LatestVersionID: doc.version.ID, Seq: doc.seq, Text: textedit.Excerpt(state, applied[i], conflictTextRunes)}
		}
		applied = textedit.Transform(state, applied, op, true)
		if err := state.Patch(op); err != nil {
			return nil, nil, fmt.Errorf("an operation of the log does not fit the state before it: %v", err)
		}
	}
	if err := state.Patch(applied); err != nil {
		return nil, nil, fmt.Errorf("the change does not move over the operations: %v", err)
	}
	return applied, state.Bytes(), nil
}
