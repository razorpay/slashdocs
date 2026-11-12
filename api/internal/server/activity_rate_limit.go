package server

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// A bounded per-principal budget of requests per minute for notification
// settings, link discovery, and live viewer reports. This protects expensive
// HTML reads independently of Slack delivery limits.
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
