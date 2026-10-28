package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// Live document events ride the document KV event stream. Writes announce
// "document" and "comments" events, viewers publish "presence" events, and
// pointers relay "cursor" events, so every open viewer on every server replica
// sees them without polling.

const (
	maxPresenceBytes       = 4 * 1024
	maxPresenceQuoteRunes  = 512
	maxPresenceContextLen  = 64
	maxPresenceVersionSize = 64
	maxCursorBytes         = 4 * 1024
	maxCursorPoints        = 16
	maxCursorZoom          = 100
	// A view's place may lie outside its element, up to this many times its size.
	maxViewFraction       = 1000
	liveEventWriteTimeout = 5 * time.Second
)

var (
	presenceSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	// A cursor path holds at most 64 child indexes, separated by dots.
	cursorPathPattern = regexp.MustCompile(`^(\d{1,5}(\.\d{1,5}){0,63})?$`)
)

// presence is one viewer session's place in a document: the version on screen
// and a short passage near the top of the viewport. The server adds identity.
type presence struct {
	Session    string       `json:"session"`
	Version    string       `json:"version,omitempty"`
	Anchor     *repo.Anchor `json:"anchor,omitempty"`
	Left       bool         `json:"left,omitempty"`
	PictureURL string       `json:"picture_url,omitempty"`
}

func (p presence) valid() bool {
	if !presenceSessionPattern.MatchString(p.Session) || len(p.Version) > maxPresenceVersionSize {
		return false
	}
	a := p.Anchor
	return a == nil || (len([]rune(a.Quote)) <= maxPresenceQuoteRunes &&
		len([]rune(a.Prefix)) <= maxPresenceContextLen &&
		len([]rune(a.Suffix)) <= maxPresenceContextLen &&
		a.StartOffset >= 0 && a.EndOffset >= a.StartOffset)
}

// cursor is a batch of pointer positions from one viewer session. A point
// names an element by its child indexes under the document body, and a place
// in that element as fractions of its width and height. A hidden point means
// that the pointer left the document. T is the time of the point in
// milliseconds on the clock of the session. Z, when set, is how much larger
// the element shows than its layout size, as on a zoomed canvas. V, when set,
// is the place at the center of the viewer's view, which followers show.
type cursor struct {
	Session string        `json:"session"`
	Version string        `json:"version"`
	Points  []cursorPoint `json:"points"`
}

type cursorPoint struct {
	T      int64        `json:"t"`
	Path   string       `json:"path"`
	X      float64      `json:"x"`
	Y      float64      `json:"y"`
	Z      float64      `json:"z,omitempty"`
	V      *cursorPlace `json:"v,omitempty"`
	Hidden bool         `json:"hidden,omitempty"`
}

// cursorPlace is a place in the document, named like a cursor point.
type cursorPlace struct {
	Path string  `json:"path"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Z    float64 `json:"z,omitempty"`
}

// valid checks a place whose fractions lie between lo and hi.
func (p cursorPlace) valid(lo, hi float64) bool {
	return p.X >= lo && p.X <= hi && p.Y >= lo && p.Y <= hi && p.Z >= 0 && p.Z <= maxCursorZoom &&
		cursorPathPattern.MatchString(p.Path)
}

func (c cursor) valid() bool {
	if !presenceSessionPattern.MatchString(c.Session) || len(c.Version) > maxPresenceVersionSize ||
		len(c.Points) == 0 || len(c.Points) > maxCursorPoints {
		return false
	}
	for _, p := range c.Points {
		place := cursorPlace{Path: p.Path, X: p.X, Y: p.Y, Z: p.Z}
		if p.T < 0 || !place.valid(0, 1) || (p.V != nil && !p.V.valid(-maxViewFraction, maxViewFraction)) {
			return false
		}
	}
	return true
}

// postDocumentCursor relays pointer positions to the other viewers. The
// positions are never stored: a viewer who is not connected misses them.
func (h handlers) postDocumentCursor(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCursorBytes)
	var in cursor
	if err := c.ShouldBindJSON(&in); err != nil || !in.valid() {
		badRequest(c, "invalid cursor")
		return
	}
	data, err := json.Marshal(in)
	if err != nil {
		internalErr(c, err)
		return
	}
	event := repo.DocumentKVEvent{DocumentID: docID, Kind: repo.DocumentEventCursor, Data: data, UpdatedBy: current(c)}
	if err := h.deps.documentKVEvents.Relay(c.Request.Context(), event); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h handlers) postDocumentPresence(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxPresenceBytes)
	var in presence
	if err := c.ShouldBindJSON(&in); err != nil || !in.valid() {
		badRequest(c, "invalid presence")
		return
	}
	p := current(c)
	in.Left = false
	in.PictureURL = p.PictureURL
	if in.Anchor != nil {
		in.Anchor.DOMPath = ""
		in.Anchor.Kind = ""
		in.Anchor.Point = nil
	}
	if err := h.appendPresence(c.Request.Context(), docID, in, *p); err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h handlers) appendPresence(ctx context.Context, docID string, state presence, actor auth.Principal) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return h.deps.repository.AppendDocumentEvent(ctx, docID, repo.DocumentEventPresence, data, actor)
}

// leavePresence marks a viewer session as gone when its stream ends. The
// request context is already cancelled by then, so the write gets its own.
func (h handlers) leavePresence(c *gin.Context, docID, session string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), liveEventWriteTimeout)
	defer cancel()
	err := h.appendPresence(ctx, docID, presence{Session: session, Left: true}, *current(c))
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		slog.WarnContext(ctx, "document presence leave failed",
			slog.String("document_id", docID),
			slog.Any("error", err))
	}
}

// announce tells open viewers that a write changed the document or its
// comments. The write already succeeded, so a failure here is only logged.
func (h handlers) announce(c *gin.Context, kind string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), liveEventWriteTimeout)
	defer cancel()
	docID := c.Param("id")
	if err := h.deps.repository.AppendDocumentEvent(ctx, docID, kind, nil, *current(c)); err != nil {
		slog.WarnContext(ctx, "document event announcement failed",
			slog.String("document_id", docID),
			slog.String("kind", kind),
			slog.Any("error", err))
	}
}
