package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// The live connection of a document page is one WebSocket. It carries the
// events of the document stream to the viewer, and the presence and the
// cursor of the viewer to the other viewers. The connection is the presence
// of its viewer: the server keeps them listed while it is open, and marks
// them gone when it closes.

const (
	// liveReadLimit is the size of the largest report of a viewer.
	liveReadLimit = max(maxPresenceBytes, maxCursorBytes)
	// liveRefused plus an HTTP status is the code that closes a connection
	// that the server refuses: 4401 asks the viewer to sign in, and 4403
	// tells that they cannot read the document, or no longer can. The viewer
	// does not connect again.
	liveRefused     websocket.StatusCode = 4000
	liveAccessEnded                      = liveRefused + http.StatusForbidden
)

// liveWriteTimeout ends the connection of a viewer who does not take an
// event, or answer a ping, in this time. A viewer whose buffer fills before
// that loses their subscription, and connects again after the last event
// that they took. Neither one holds up the broker.
var liveWriteTimeout = 10 * time.Second

// liveMessage is a message to the viewer: an event of the document. ID is
// the revision to resume after. An event that is not stored has none.
type liveMessage struct {
	ID    int64                `json:"id,omitempty"`
	Event repo.DocumentKVEvent `json:"event"`
}

// liveReport is a message from the viewer. Type "presence" reports their
// place in the document, "cursor" relays their pointer, and "left" tells
// that they go.
type liveReport struct {
	Type    string        `json:"type"`
	Version string        `json:"version"`
	Anchor  *repo.Anchor  `json:"anchor,omitempty"`
	Points  []cursorPoint `json:"points,omitempty"`
}

// liveConn is the WebSocket of one viewer. It is the sink of their stream.
type liveConn struct {
	ctx     context.Context
	conn    *websocket.Conn
	h       handlers
	docID   string
	session string
	viewer  auth.Principal
	// place is the presence that the viewer reported last, while they are
	// listed. Each keep-alive reports it again. mu keeps the writes of
	// presence in order, so that no report comes after the viewer left.
	mu    sync.Mutex
	place *presence
}

func (l *liveConn) send(event repo.DocumentKVEvent, withID bool) error {
	message := liveMessage{Event: event}
	if withID {
		message.ID = event.Revision
	}
	ctx, cancel := context.WithTimeout(l.ctx, liveWriteTimeout)
	defer cancel()
	return wsjson.Write(ctx, l.conn, message)
}

func (*liveConn) flush() {}

// keepAlive pings the viewer, and keeps them listed.
func (l *liveConn) keepAlive() error {
	ctx, cancel := context.WithTimeout(l.ctx, liveWriteTimeout)
	defer cancel()
	if err := l.conn.Ping(ctx); err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.place != nil {
		l.report(l.h.reportPresence(l.ctx, l.docID, *l.place, l.viewer))
	}
	return nil
}

// reportPresence lists the viewer at a place.
func (l *liveConn) reportPresence(place presence) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.report(l.h.reportPresence(l.ctx, l.docID, place, l.viewer)) {
		l.place = &place
	}
}

// listen takes the reports of the viewer until the connection ends. Each
// kind of report has the budget of its POST route. A report over the budget,
// or one that is not valid, is dropped. An anonymous reader reports nothing.
func (l *liveConn) listen(presenceLimit, cursorLimit *activityLimit, key string) {
	for {
		var in liveReport
		if err := wsjson.Read(l.ctx, l.conn, &in); err != nil {
			return
		}
		if l.session == "" {
			continue
		}
		switch in.Type {
		case repo.DocumentEventPresence:
			if presenceLimit.allow(key) {
				l.reportPresence(presence{Session: l.session, Version: in.Version, Anchor: in.Anchor})
			}
		case repo.DocumentEventCursor:
			if cursorLimit.allow(key) {
				l.report(l.h.relayCursor(l.ctx, l.docID, cursor{Session: l.session, Version: in.Version, Points: in.Points}, l.viewer))
			}
		case "left":
			l.leave()
		}
	}
}

// report logs a report that failed for another reason than its content, and
// tells whether it succeeded.
func (l *liveConn) report(err error) bool {
	if err != nil && !errors.Is(err, errInvalidReport) && l.ctx.Err() == nil {
		slog.WarnContext(l.ctx, "document live report failed",
			slog.String("document_id", l.docID),
			slog.Any("error", err))
	}
	return err == nil
}

// leave marks the viewer as gone, if they are listed.
func (l *liveConn) leave() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.place == nil {
		return
	}
	l.place = nil
	ctx, cancel := context.WithTimeout(context.WithoutCancel(l.ctx), liveEventWriteTimeout)
	defer cancel()
	l.report(l.h.appendPresence(ctx, l.docID, presence{Session: l.session, Left: true}, l.viewer))
}

// DocumentLive godoc
// @Summary Connect to the live events of a document over a WebSocket
// @Description For the browser, which shows the live document, its viewers and their cursors. The request upgrades to a WebSocket. The server sends each event of the document as {"id": revision, "event": event}, with the events and the data of GET /v1/documents/{id}/kv/events. id is absent on an event that is not stored. A connection that names after_revision gets the stored events after it first. Each connection then gets the current viewers, and a document event with the seq of the live document and its current version. A viewer with a session sends {"type": "presence", "version", "anchor"} when their place changes, {"type": "cursor", "version", "points"} as their pointer moves, and {"type": "left"} when they go. These have the validation, the size limits and the rate limits of POST /v1/documents/{id}/presence and POST /v1/documents/{id}/cursor, and the server drops a report that fails them. The server lists the viewer while the connection is open, and marks them gone when it closes. A browser connects only from the origin of the server. The server pings each 25 seconds. It closes with code 4403 when the viewer can no longer read the document, and with 1001 when it stops.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param after_revision query int false "Revision to resume after. Omit it to start at the live edge"
// @Param session query string false "Viewer session: 8 to 64 characters of A-Z, a-z, 0-9, _ and -"
// @Success 101
// @Failure 400 {object} errorEnvelope
// @Failure 401 {object} errorEnvelope
// @Failure 403 {object} errorEnvelope
// @Failure 404 {object} errorEnvelope
// @Router /v1/documents/{id}/live [get]
func (h handlers) documentLive(presenceLimit, cursorLimit *activityLimit) gin.HandlerFunc {
	return func(c *gin.Context) {
		stream, liveEvents, ok := h.openDocumentStream(c)
		if !ok {
			return
		}
		defer stream.close()
		clearDeadlines(c)
		// Accept refuses a browser on another origin than the request's, so
		// that another site cannot connect with the viewer's cookie.
		conn, err := websocket.Accept(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(liveReadLimit)
		live := &liveConn{ctx: c.Request.Context(), conn: conn, h: h, docID: stream.documentID, session: stream.session, viewer: stream.principal}
		stream.sink = live
		key := activityKey(c)
		listened := make(chan struct{})
		go func() {
			defer close(listened)
			live.listen(presenceLimit, cursorLimit, key)
			stream.close()
		}()

		err = h.start(stream)
		if err == nil {
			err = stream.sendPosition()
		}
		if err == nil {
			err = stream.run(liveEvents)
		}
		switch {
		case errors.Is(err, errAccessEnded):
			_ = conn.Close(liveAccessEnded, "access ended")
		case h.deps.streams.Err() != nil:
			_ = conn.Close(websocket.StatusGoingAway, "server stops")
		case err != nil:
			_ = conn.Close(websocket.StatusTryAgainLater, "")
		}
		_ = conn.CloseNow()
		<-listened
		live.leave()
	}
}

// refusedLive holds back the HTTP answer that refuses a live connection.
type refusedLive struct {
	gin.ResponseWriter
	status int
}

func (w *refusedLive) WriteHeader(status int) {
	if status < http.StatusBadRequest {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.status = status
}

func (w *refusedLive) WriteHeaderNow() {
	if w.status == 0 {
		w.ResponseWriter.WriteHeaderNow()
	}
}

func (w *refusedLive) Write(body []byte) (int, error) {
	if w.status != 0 {
		return len(body), nil
	}
	return w.ResponseWriter.Write(body)
}

func (w *refusedLive) WriteString(body string) (int, error) {
	return w.Write([]byte(body))
}

// Unwrap lets http.ResponseController reach the connection.
func (w *refusedLive) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// refuseOverWebSocket tells a browser why the server refused its live
// connection. A page cannot read the status of a refused handshake, so it
// cannot tell a refusal from a network that failed, and would connect again
// forever. Instead of the status, the server takes the connection and closes
// it at once with liveRefused plus the status.
func refuseOverWebSocket(c *gin.Context) {
	refused := &refusedLive{ResponseWriter: c.Writer}
	c.Writer = refused
	c.Next()
	if refused.status == 0 {
		return
	}
	conn, err := websocket.Accept(refused.ResponseWriter, c.Request, nil)
	if err != nil {
		return
	}
	_ = conn.Close(liveRefused+websocket.StatusCode(refused.status), http.StatusText(refused.status))
}
