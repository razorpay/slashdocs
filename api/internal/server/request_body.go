package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

const maxJSONBytes = 1 << 20
const maxMultipartBytes = maxHTMLBytes + (1 << 20)

func requestBodyMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// MCP accepts escaped HTML and keeps its transport error metrics.
		if c.FullPath() == "/mcp" {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMCPRequestBytes)
			c.Next()
			return
		}
		limit := int64(maxJSONBytes)
		multipart := c.Request.Method == http.MethodPost &&
			(c.FullPath() == "/v1/documents" || c.FullPath() == "/v1/documents/:id/versions")
		if multipart {
			limit = maxMultipartBytes
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		if c.Request.ContentLength > limit {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "request body is too large", nil))
			return
		}
		c.Next()
	}
}
