package server

import (
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

// activityLimit gives each principal a budget of requests for each minute.
// The routes that a page calls often have one: notification settings, link
// discovery, viewer reports, presence, cursors, the operations of the
// browser editor, and the reads that follow the live document. The writes
// that read or seal the live document have one too: decisions and comment
// updates. It protects the reads of HTML and the writes to the log, and does
// not depend on the limits of Slack delivery.
type activityLimit struct {
	perMinute int
	mu        sync.Mutex
	windows   map[string]activityWindow
}

type activityWindow struct {
	start time.Time
	count int
}

func newActivityLimit(perMinute int) *activityLimit {
	return &activityLimit{perMinute: perMinute, windows: map[string]activityWindow{}}
}

// activityRateLimit is a middleware with a budget of its own.
func activityRateLimit(perMinute int) gin.HandlerFunc { return newActivityLimit(perMinute).handle }

func (l *activityLimit) handle(c *gin.Context) {
	if !l.allow(activityKey(c)) {
		c.Header("Retry-After", "60")
		c.AbortWithStatusJSON(http.StatusTooManyRequests, errorResponse("rate_limited", "Too many requests. Try again in a minute.", nil))
		return
	}
	c.Next()
}

// activityKey names the budget of the caller.
func activityKey(c *gin.Context) string {
	p := current(c)
	key := string(p.Type) + ":" + p.ID
	if p.Type == auth.PrincipalAnonymous {
		// Anonymous readers have no id, so each address has a budget. The
		// address of the connection is used, because a caller can set the
		// forwarding headers. Nothing that the caller chooses is in the
		// key: this check runs before the role check, and one address
		// with many keys would fill the table for all principals.
		host, _, _ := net.SplitHostPort(c.Request.RemoteAddr)
		key += host
	}
	return key
}

// allow counts one request against the budget of key, and reports whether
// the budget had room for it.
func (l *activityLimit) allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.windows[key]
	if now.Sub(w.start) >= time.Minute {
		w = activityWindow{start: now}
	}
	if len(l.windows) >= 10000 {
		for k, v := range l.windows {
			if now.Sub(v.start) >= time.Minute {
				delete(l.windows, k)
			}
		}
	}
	_, exists := l.windows[key]
	if w.count >= l.perMinute || (!exists && len(l.windows) >= 10000) {
		return false
	}
	w.count++
	l.windows[key] = w
	return true
}
