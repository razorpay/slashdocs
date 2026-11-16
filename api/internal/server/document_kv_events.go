package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const (
	documentKVReplayLimit = 100
	documentKVKeepAlive   = 25 * time.Second
	// presenceTTL is how long a viewer stays listed without a heartbeat.
	presenceTTL = 45 * time.Second
	// folderAccessDelay is how long a stream waits after a change of a
	// folder before it examines the access of its viewer. A change of a
	// folder wakes every open stream, so each stream examines it once for
	// all of the changes in that time.
	folderAccessDelay = time.Second
)

type documentKVStream struct {
	ctx          context.Context
	sink         eventSink
	repository   documentKVStreamRepository
	authenticate func(context.Context) (*auth.Principal, error)
	principal    auth.Principal
	documentID   string
	// session names the viewer, whom the server lists until the stream ends.
	session   string
	lastSent  int64
	keepAlive <-chan time.Time
	started   bool
	// The check of access after a change of a folder, while one waits.
	folderChanged <-chan time.Time
	// close ends the subscription and the context of the stream.
	close func()
}

// eventSink carries the events of a stream to its viewer: SSE or a
// WebSocket. An event with an id is one that the viewer can resume after.
type eventSink interface {
	send(event repo.DocumentKVEvent, withID bool) error
	flush()
	keepAlive() error
}

type sseSink struct {
	writer  http.ResponseWriter
	flusher http.Flusher
}

func (s sseSink) send(event repo.DocumentKVEvent, withID bool) error {
	return writeDocumentEventSSE(s.writer, event, withID)
}

func (s sseSink) flush() { s.flusher.Flush() }

func (s sseSink) keepAlive() error {
	_, err := fmt.Fprint(s.writer, ": keepalive\n\n")
	return err
}

type documentKVStreamRepository interface {
	GetDocument(context.Context, string) (repo.Document, error)
	ListDocumentKVEvents(context.Context, string, int64, int32) ([]repo.DocumentKVEvent, error)
	RoleForDocument(context.Context, auth.Principal, string) (repo.Role, error)
}

func (s *documentKVStream) sendBacklog() error {
	for {
		events, err := s.repository.ListDocumentKVEvents(s.ctx, s.documentID, s.lastSent, documentKVReplayLimit)
		if err != nil {
			return err
		}
		for _, event := range events {
			if event.Revision <= s.lastSent {
				continue
			}
			s.started = true
			if !stalePresence(event) {
				if err := s.sink.send(event, true); err != nil {
					return err
				}
			}
			s.lastSent = event.Revision
		}
		s.sink.flush()
		if len(events) < documentKVReplayLimit {
			return nil
		}
	}
}

func (s *documentKVStream) sendLive(event repo.DocumentKVEvent) error {
	// A relayed event is not stored, so it has no revision to resume from.
	if event.Revision == 0 {
		if err := s.sink.send(event, false); err != nil {
			return err
		}
		s.sink.flush()
		return nil
	}
	if event.Revision <= s.lastSent {
		return nil
	}
	if event.Revision > s.lastSent+1 {
		if err := s.sendBacklog(); err != nil {
			return err
		}
		if event.Revision <= s.lastSent {
			return nil
		}
	}
	s.started = true
	if err := s.sink.send(event, true); err != nil {
		return err
	}
	s.lastSent = event.Revision
	s.sink.flush()
	return nil
}

// sendPosition tells the viewer where the live document is, with an event
// that is not stored. A viewer who missed the relayed event of an operation
// then asks for the changes. A read that fails sends nothing: the next
// keep-alive sends the position.
func (s *documentKVStream) sendPosition() error {
	d, err := s.repository.GetDocument(s.ctx, s.documentID)
	if err != nil {
		return nil
	}
	data, err := json.Marshal(repo.DocumentPosition{Seq: d.Seq, VersionID: d.CurrentVersionID})
	if err != nil {
		return err
	}
	return s.sink.send(repo.DocumentKVEvent{DocumentID: s.documentID, Kind: repo.DocumentEventDocument, Data: data}, false)
}

func (s *documentKVStream) reauthorize() bool {
	if s.authenticate == nil {
		return false
	}
	principal, err := s.authenticate(s.ctx)
	if err != nil {
		if s.ctx.Err() == nil && !errors.Is(err, auth.ErrUnauthorized) {
			slog.ErrorContext(s.ctx, "document KV stream credential check failed",
				slog.String("document_id", s.documentID),
				slog.Any("error", err))
		}
		return false
	}
	if principal == nil || principal.Type != s.principal.Type || principal.ID != s.principal.ID {
		return false
	}
	role, err := s.repository.RoleForDocument(s.ctx, s.principal, s.documentID)
	if err != nil {
		if s.ctx.Err() == nil {
			slog.ErrorContext(s.ctx, "document KV stream authorization check failed",
				slog.String("document_id", s.documentID),
				slog.Any("error", err))
		}
		return false
	}
	return atLeast(role, repo.RoleViewer)
}

// errAccessEnded ends the stream of a viewer who can no longer read the
// document, or whose credential no longer holds.
var errAccessEnded = errors.New("access to the document ended")

// recheck examines the access of the viewer again.
func (s *documentKVStream) recheck() error {
	if !s.reauthorize() {
		return errAccessEnded
	}
	return nil
}

// hear sends a live event to the viewer. A grant changed: a viewer who lost
// access gets no more events. An event of no document is a change of a
// folder, which the stream examines after folderAccessDelay, once for all of
// the changes in that time.
func (s *documentKVStream) hear(event repo.DocumentKVEvent) error {
	if event.Kind != repo.DocumentEventAccess {
		return s.sendLive(event)
	}
	if event.DocumentID != "" {
		return s.recheck()
	}
	if s.folderChanged == nil {
		s.folderChanged = time.After(folderAccessDelay)
	}
	return nil
}

// errSubscriptionEnded ends the stream of a viewer whose buffer of events
// filled, or of a document that went. The viewer connects again.
var errSubscriptionEnded = errors.New("the subscription to the document ended")

// run sends the live events until the stream ends, and tells why it ended.
// It returns nil when the context of the stream ended.
func (s *documentKVStream) run(liveEvents <-chan repo.DocumentKVEvent) error {
	keepAlive := s.keepAlive
	if keepAlive == nil {
		ticker := time.NewTicker(documentKVKeepAlive)
		defer ticker.Stop()
		keepAlive = ticker.C
	}

	for {
		select {
		case <-s.ctx.Done():
			return nil
		case event, ok := <-liveEvents:
			if !ok {
				return errSubscriptionEnded
			}
			if err := s.hear(event); err != nil {
				return err
			}
		case <-s.folderChanged:
			s.folderChanged = nil
			if err := s.recheck(); err != nil {
				return err
			}
		case <-keepAlive:
			if err := s.recheck(); err != nil {
				return err
			}
			if err := s.sink.keepAlive(); err != nil {
				return err
			}
			if err := s.sendPosition(); err != nil {
				return err
			}
			s.sink.flush()
		}
	}
}

// openDocumentStream checks that the viewer may read the document, and
// subscribes to its events. A connection with neither after_revision nor
// Last-Event-ID starts at the live edge. It answers the request itself when
// it fails. The stream also ends when the server stops.
func (h handlers) openDocumentStream(c *gin.Context) (*documentKVStream, <-chan repo.DocumentKVEvent, bool) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
		return nil, nil, false
	}
	session := c.Query("session")
	if current(c).Type == auth.PrincipalAnonymous {
		// Other viewers do not see an anonymous reader.
		session = ""
	}
	if session != "" && !presenceSessionPattern.MatchString(session) {
		badRequest(c, "invalid presence session")
		return nil, nil, false
	}
	fromLiveEdge := c.Query("after_revision") == "" && c.GetHeader("Last-Event-ID") == ""
	afterRevision, err := parseKVEventRevision(c.Query("after_revision"))
	if err != nil {
		badRequest(c, "invalid event revision")
		return nil, nil, false
	}
	lastEventRevision, err := parseKVEventRevision(c.GetHeader("Last-Event-ID"))
	if err != nil {
		badRequest(c, "invalid event revision")
		return nil, nil, false
	}
	afterRevision = max(afterRevision, lastEventRevision)
	ctx, cancel := context.WithCancel(c.Request.Context())
	stopWithServer := context.AfterFunc(h.deps.streams, cancel)
	liveEvents, unsubscribe, err := h.deps.documentKVEvents.Subscribe(ctx, docID)
	closeStream := func() {
		unsubscribe()
		stopWithServer()
		cancel()
	}
	if err != nil {
		closeStream()
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
		} else {
			internalErr(c, err)
		}
		return nil, nil, false
	}
	// Read the live edge only after subscribing, so no event falls between.
	if fromLiveEdge {
		afterRevision, err = h.deps.repository.CurrentDocumentKVRevision(ctx, docID)
		if err != nil {
			closeStream()
			internalErr(c, err)
			return nil, nil, false
		}
	}
	authRequest := c.Request.Clone(ctx)
	return &documentKVStream{
		ctx:        ctx,
		repository: h.deps.repository,
		authenticate: func(ctx context.Context) (*auth.Principal, error) {
			return h.deps.readerAuthenticator().Authenticate(authRequest.Clone(ctx))
		},
		principal:  *current(c),
		documentID: docID,
		session:    session,
		lastSent:   afterRevision,
		close:      closeStream,
	}, liveEvents, true
}

// start sends the events that the viewer missed, and then lists the current
// viewers.
func (h handlers) start(stream *documentKVStream) error {
	if err := stream.sendBacklog(); err != nil {
		return err
	}
	stream.started = true
	h.sendPresenceSnapshot(stream)
	return nil
}

// streamDocumentKVEvents streams the document's live event log over SSE: KV
// changes, document and comment change notices, and viewer presence. A
// session parameter marks the viewer as gone when the stream ends.
func (h handlers) streamDocumentKVEvents(c *gin.Context) {
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		internalErr(c, errors.New("streaming unsupported"))
		return
	}
	stream, liveEvents, ok := h.openDocumentStream(c)
	if !ok {
		return
	}
	defer stream.close()
	clearDeadlines(c)
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	stream.sink = sseSink{writer: c.Writer, flusher: flusher}
	if err := h.start(stream); err != nil {
		switch {
		case stream.started:
			slog.ErrorContext(c.Request.Context(), "document KV stream backlog failed",
				slog.String("document_id", stream.documentID),
				slog.Any("error", err))
		case errors.Is(err, repo.ErrNotFound):
			notFound(c)
		default:
			internalErr(c, err)
		}
		return
	}
	if _, err := fmt.Fprint(c.Writer, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()
	_ = stream.run(liveEvents)
	if stream.session != "" {
		h.leavePresence(c, stream.documentID, stream.session)
	}
}

// clearDeadlines lets a stream outlive the server-wide read timeout: an
// expiring deadline would sever it. The errors are ignored: recorders and
// exotic writers that don't support deadlines never had them to begin with.
func clearDeadlines(c *gin.Context) {
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
}

// sendPresenceSnapshot lists the current viewers. The events carry no id,
// so the viewer's last revision never moves backwards.
func (h handlers) sendPresenceSnapshot(stream *documentKVStream) {
	events, err := h.deps.repository.ListDocumentPresence(stream.ctx, stream.documentID, presenceTTL)
	if err != nil {
		slog.WarnContext(stream.ctx, "document presence snapshot failed",
			slog.String("document_id", stream.documentID),
			slog.Any("error", err))
		return
	}
	for _, event := range events {
		if err := stream.sink.send(event, false); err != nil {
			return
		}
	}
}

func parseKVEventRevision(raw string) (int64, error) {
	if raw == "" {
		return 0, nil
	}
	revision, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || revision < 0 {
		return 0, errors.New("invalid revision")
	}
	return revision, nil
}

// writeDocumentEventSSE writes KV changes as unnamed messages, which the
// render bridge has always consumed, and other kinds as named events.
func writeDocumentEventSSE(w http.ResponseWriter, event repo.DocumentKVEvent, withID bool) error {
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	var header strings.Builder
	if withID {
		fmt.Fprintf(&header, "id: %d\n", event.Revision)
	}
	if event.Kind != "" && event.Kind != repo.DocumentEventKV {
		fmt.Fprintf(&header, "event: %s\n", event.Kind)
	}
	_, err = fmt.Fprintf(w, "%sdata: %s\n\n", header.String(), raw)
	return err
}

// stalePresence reports a presence event too old to describe a live viewer.
// Replaying it after a reconnect would bring back a viewer who already left.
func stalePresence(event repo.DocumentKVEvent) bool {
	if event.Kind != repo.DocumentEventPresence {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, event.UpdatedAt)
	return err != nil || time.Since(at) > presenceTTL
}
