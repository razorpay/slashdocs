package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// A viewer who does not read ends their stream after liveWriteTimeout. The
// stream does not wait on them for longer, and so neither does the broker.
func TestLiveStreamEndsForAViewerWhoDoesNotRead(t *testing.T) {
	defer func(was time.Duration) { liveWriteTimeout = was }(liveWriteTimeout)
	liveWriteTimeout = 50 * time.Millisecond
	accepted := make(chan *websocket.Conn, 1)
	done := make(chan struct{})
	defer close(done)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		accepted <- conn
		<-done
	}))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	viewer, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http"), nil) //nolint:bodyclose // The connection owns the body of the handshake response.
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = viewer.CloseNow() }()
	conn := <-accepted
	stream := &documentKVStream{ctx: ctx, sink: &liveConn{ctx: ctx, conn: conn}, keepAlive: make(chan time.Time)}

	events := make(chan repo.DocumentKVEvent)
	ended := make(chan error, 1)
	go func() { ended <- stream.run(events) }()
	cursor := repo.DocumentKVEvent{Kind: repo.DocumentEventCursor, Data: json.RawMessage(strconv.Quote(strings.Repeat("x", 64<<10)))}
	for {
		select {
		case events <- cursor:
		case err := <-ended:
			if err == nil {
				t.Fatal("run ended without an error, want the write timeout")
			}
			return
		case <-ctx.Done():
			t.Fatal("the stream waits on a viewer who does not read")
		}
	}
}
