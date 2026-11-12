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
	writer       http.ResponseWriter
	flusher      http.Flusher
	repository   documentKVStreamRepository
	authenticate func(context.Context) (*auth.Principal, error)
	principal    auth.Principal
	documentID   string
	lastSent     int64
	keepAlive    <-chan time.Time
	started      bool
	// The check of access after a change of a folder, while one waits.
	folderChanged <-chan time.Time
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
				if err := writeDocumentEventSSE(s.writer, event, true); err != nil {
					return err
				}
			}
			s.lastSent = event.Revision
		}
		s.flusher.Flush()
		if len(events) < documentKVReplayLimit {
			return nil
		}
	}
}

func (s *documentKVStream) sendLive(event repo.DocumentKVEvent) error {
	// A relayed event is not stored, so it has no revision to resume from.
	if event.Revision == 0 {
		if err := writeDocumentEventSSE(s.writer, event, false); err != nil {
			return err
		}
		s.flusher.Flush()
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
	if err := writeDocumentEventSSE(s.writer, event, true); err != nil {
		return err
	}
	s.lastSent = event.Revision
	s.flusher.Flush()
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
	return writeDocumentEventSSE(s.writer, repo.DocumentKVEvent{DocumentID: s.documentID, Kind: repo.DocumentEventDocument, Data: data}, false)
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

// hear sends a live event to the viewer, and reports whether the stream
// goes on. A grant changed: a viewer who lost access gets no more events. An
// event of no document is a change of a folder, which the stream examines
// after folderAccessDelay, once for all of the changes in that time.
func (s *documentKVStream) hear(event repo.DocumentKVEvent) bool {
	if event.Kind != repo.DocumentEventAccess {
		return s.sendLive(event) == nil
	}
	if event.DocumentID != "" {
		return s.reauthorize()
	}
	if s.folderChanged == nil {
		s.folderChanged = time.After(folderAccessDelay)
	}
	return true
}

func (s *documentKVStream) run(liveEvents <-chan repo.DocumentKVEvent) {
	keepAlive := s.keepAlive
	var ticker *time.Ticker
	if keepAlive == nil {
		ticker = time.NewTicker(documentKVKeepAlive)
		defer ticker.Stop()
		keepAlive = ticker.C
	}

	for {
		select {
		case <-s.ctx.Done():
			return
		case event, ok := <-liveEvents:
			if !ok || !s.hear(event) {
				return
			}
		case <-s.folderChanged:
			s.folderChanged = nil
			if !s.reauthorize() {
				return
			}
		case <-keepAlive:
			if !s.reauthorize() {
				return
			}
			if _, err := fmt.Fprint(s.writer, ": keepalive\n\n"); err != nil {
				return
			}
			if err := s.sendPosition(); err != nil {
				return
			}
			s.flusher.Flush()
		}
	}
}

// streamDocumentKVEvents streams the document's live event log: KV changes,
// document and comment change notices, and viewer presence. A connection with
// neither after_revision nor Last-Event-ID starts at the live edge. A session
// parameter marks the viewer as gone when the stream ends.
func (h handlers) streamDocumentKVEvents(c *gin.Context) { //nolint:gocyclo // SSE handshake: resume, snapshot, and presence branches read best as one sequence.
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	session := c.Query("session")
	if current(c).Type == auth.PrincipalAnonymous {
		// Other viewers do not see an anonymous reader.
		session = ""
	}
	if session != "" && !presenceSessionPattern.MatchString(session) {
		badRequest(c, "invalid presence session")
		return
	}
	fromLiveEdge := c.Query("after_revision") == "" && c.GetHeader("Last-Event-ID") == ""
	afterRevision, err := parseKVEventRevision(c.Query("after_revision"))
	if err != nil {
		badRequest(c, "invalid event revision")
		return
	}
	lastEventRevision, err := parseKVEventRevision(c.GetHeader("Last-Event-ID"))
	if err != nil {
		badRequest(c, "invalid event revision")
		return
	}
	afterRevision = max(afterRevision, lastEventRevision)
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		internalErr(c, errors.New("streaming unsupported"))
		return
	}
	liveEvents, unsubscribe, err := h.deps.documentKVEvents.Subscribe(c.Request.Context(), docID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	defer unsubscribe()
	// Read the live edge only after subscribing, so no event falls between.
	if fromLiveEdge {
		afterRevision, err = h.deps.repository.CurrentDocumentKVRevision(c.Request.Context(), docID)
		if err != nil {
			internalErr(c, err)
			return
		}
	}

	// This stream outlives the server-wide read timeout; clear the connection
	// deadlines so an expiring deadline doesn't sever the SSE response. The
	// errors are ignored: recorders and exotic writers that don't support
	// deadlines never had them to begin with.
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	authRequest := c.Request.Clone(c.Request.Context())
	stream := &documentKVStream{
		ctx:        c.Request.Context(),
		writer:     c.Writer,
		flusher:    flusher,
		repository: h.deps.repository,
		authenticate: func(ctx context.Context) (*auth.Principal, error) {
			return h.deps.readerAuthenticator().Authenticate(authRequest.Clone(ctx))
		},
		principal:  *current(c),
		documentID: docID,
		lastSent:   afterRevision,
	}
	if err := stream.sendBacklog(); err != nil {
		if stream.started {
			slog.ErrorContext(c.Request.Context(), "document KV stream backlog failed",
				slog.String("document_id", docID),
				slog.Any("error", err))
			return
		}
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	stream.started = true
	h.writePresenceSnapshot(c, docID)
	if _, err := fmt.Fprint(c.Writer, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()
	stream.run(liveEvents)
	if session != "" {
		h.leavePresence(c, docID, session)
	}
}

// writePresenceSnapshot lists the current viewers. The events carry no id, so
// the client's Last-Event-ID never moves backwards.
func (h handlers) writePresenceSnapshot(c *gin.Context, docID string) {
	events, err := h.deps.repository.ListDocumentPresence(c.Request.Context(), docID, presenceTTL)
	if err != nil {
		slog.WarnContext(c.Request.Context(), "document presence snapshot failed",
			slog.String("document_id", docID),
			slog.Any("error", err))
		return
	}
	for _, event := range events {
		if err := writeDocumentEventSSE(c.Writer, event, false); err != nil {
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
