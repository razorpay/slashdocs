package server

import (
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

// activityRateLimit gives each principal a budget of requests for each
// minute. The routes that a page calls often have one: notification
// settings, link discovery, viewer reports, presence, cursors, the
// operations of the browser editor, and the reads that follow the live
// document. The writes that read or seal the live document have one too:
// decisions and comment updates. It protects the reads of HTML and the
// writes to the log, and does not depend on the limits of Slack delivery.
func activityRateLimit(perMinute int) gin.HandlerFunc {
	type window struct {
		start time.Time
		count int
	}
	var mu sync.Mutex
	windows := map[string]window{}
	return func(c *gin.Context) {
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
		now := time.Now()
		mu.Lock()
		w := windows[key]
		if now.Sub(w.start) >= time.Minute {
			w = window{start: now}
		}
		if len(windows) >= 10000 {
			for k, v := range windows {
				if now.Sub(v.start) >= time.Minute {
					delete(windows, k)
				}
			}
		}
		_, exists := windows[key]
		allowed := w.count < perMinute && (exists || len(windows) < 10000)
		if allowed {
			w.count++
			windows[key] = w
		}
		mu.Unlock()
		if !allowed {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, errorResponse("rate_limited", "Too many requests. Try again in a minute.", nil))
			return
		}
		c.Next()
	}
}
