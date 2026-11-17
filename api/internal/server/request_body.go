package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const maxJSONBytes = 1 << 20
const maxMultipartBytes = maxHTMLBytes + (1 << 20)

// Clients compress bodies when the deployment asks, because web application
// firewalls that scan request bodies flag document HTML as an attack.
const requestEncodingGzip = "gzip"

// lazyGzip creates the gzip reader on the first Read, so nothing is decoded
// until the route's own handler reads the body, after its auth has passed.
type lazyGzip struct {
	src io.ReadCloser
	zr  *gzip.Reader
	err error
}

func (l *lazyGzip) Read(p []byte) (int, error) {
	if l.err != nil {
		return 0, l.err
	}
	if l.zr == nil {
		l.zr, l.err = gzip.NewReader(l.src)
		if l.err != nil {
			return 0, l.err
		}
	}
	return l.zr.Read(p)
}

func (l *lazyGzip) Close() error {
	if l.zr != nil {
		_ = l.zr.Close()
	}
	return l.src.Close()
}

// requestBodyMiddleware caps the request body and, when the deployment opts in,
// transparently decodes gzip. Without the opt-in every encoded body is refused,
// so a deployment that does not ask for compression never decodes one. The cap applies to the decoded bytes: the decoder sits between two
// limit readers, so a small compressed body cannot expand past the cap, and a
// stream of empty gzip members cannot run forever. Decoding is lazy, so a gzip
// body behaves like the same plain body in every handler.
func requestBodyMiddleware(gzipEnabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := requestBodyLimit(c)
		encoding := requestEncoding(c.Request)
		// An empty body has nothing to decode; handlers treat it as no body.
		if encoding == requestEncodingGzip && gzipEnabled && c.Request.ContentLength == 0 {
			c.Request.Header.Del("Content-Encoding")
			encoding = ""
		}
		switch {
		case encoding == "" || encoding == "identity":
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
			if c.FullPath() != "/mcp" && c.Request.ContentLength > limit {
				c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "request body is too large", nil))
				return
			}
		case encoding == requestEncodingGzip && gzipEnabled:
			// Stored gzip blocks add a few bytes per 64 KiB, so a body that
			// decodes to the limit can be slightly longer than the limit.
			wireLimit := limit + limit>>10 + 1024
			if c.FullPath() != "/mcp" && c.Request.ContentLength > wireLimit {
				c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "request body is too large", nil))
				return
			}
			c.Request.Header.Del("Content-Encoding")
			c.Request.Header.Del("Content-Length")
			c.Request.ContentLength = -1
			wire := http.MaxBytesReader(c.Writer, c.Request.Body, wireLimit)
			c.Request.Body = http.MaxBytesReader(c.Writer, &lazyGzip{src: wire}, limit)
		default:
			c.AbortWithStatusJSON(http.StatusUnsupportedMediaType, errorResponse("unsupported_encoding", "unsupported content encoding", nil))
			return
		}
		c.Next()
	}
}

func requestBodyLimit(c *gin.Context) int64 {
	switch {
	case c.FullPath() == "/mcp":
		// MCP accepts escaped HTML and keeps its transport error metrics.
		return maxMCPRequestBytes
	case c.Request.Method == http.MethodPost &&
		(c.FullPath() == "/v1/documents" || c.FullPath() == "/v1/documents/:id/versions"):
		return maxMultipartBytes
	}
	return maxJSONBytes
}

func requestEncoding(r *http.Request) string {
	// Stacked encodings would need decoding in turn; no client sends them.
	if len(r.Header.Values("Content-Encoding")) > 1 {
		return "multiple"
	}
	encoding := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding")))
	// RFC 9110 asks recipients to treat x-gzip as gzip.
	if encoding == "x-gzip" {
		return requestEncodingGzip
	}
	return encoding
}
