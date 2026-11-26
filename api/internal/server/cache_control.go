package server

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// noStoreByDefaultMiddleware marks every response "private, no-store" unless
// its handler sets its own Cache-Control. Most responses depend on who asks
// (the signed-in user, a document's sharing), and a CDN or proxy in front of
// the server may cache a response that does not forbid it: one user's /v1/me
// or document list would then go to the next caller, signed in or not.
// Fingerprinted build assets under /assets/ are the same for everyone, so
// they keep the file server's caching.
func noStoreByDefaultMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, "/assets/") {
			c.Header("Cache-Control", "private, no-store")
		}
		c.Next()
	}
}
