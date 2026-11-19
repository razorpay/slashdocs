package server

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestGzipHandlerReadsNoMoreThanCap(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var got int
	var readErr error
	engine := gin.New()
	engine.Use(requestBodyMiddleware(true))
	engine.POST("/oauth/register", func(c *gin.Context) {
		b, err := io.ReadAll(c.Request.Body)
		got, readErr = len(b), err
		c.Status(http.StatusOK)
	})

	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(bytes.Repeat([]byte(" "), 4*maxJSONBytes))
	_ = zw.Close()

	req := httptest.NewRequest(http.MethodPost, "/oauth/register", &buf)
	req.Header.Set("Content-Encoding", "gzip")
	engine.ServeHTTP(httptest.NewRecorder(), req)

	var tooLarge *http.MaxBytesError
	if !errors.As(readErr, &tooLarge) {
		t.Fatalf("read error = %v, want *http.MaxBytesError", readErr)
	}
	if got > maxJSONBytes {
		t.Fatalf("handler received %d bytes, cap is %d", got, maxJSONBytes)
	}
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

// Empty gzip members decode to nothing, so only the wire cap stops a stream of
// them from being read forever.
func TestGzipWireCapStopsEmptyMembers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var readErr error
	engine := gin.New()
	engine.Use(requestBodyMiddleware(true))
	engine.POST("/oauth/register", func(c *gin.Context) {
		_, readErr = io.Copy(io.Discard, c.Request.Body)
		c.Status(http.StatusOK)
	})

	var member bytes.Buffer
	zw := gzip.NewWriter(&member)
	_ = zw.Close()
	stream := bytes.Repeat(member.Bytes(), (3*maxJSONBytes)/member.Len())
	wire := &countingReader{r: bytes.NewReader(stream)}

	req := httptest.NewRequest(http.MethodPost, "/oauth/register", wire)
	req.ContentLength = -1
	req.Header.Set("Content-Encoding", "gzip")
	engine.ServeHTTP(httptest.NewRecorder(), req)

	var tooLarge *http.MaxBytesError
	if !errors.As(readErr, &tooLarge) {
		t.Fatalf("read error = %v, want *http.MaxBytesError", readErr)
	}
	if wireLimit := maxJSONBytes + maxJSONBytes>>10 + 1024; wire.n > wireLimit+64<<10 {
		t.Fatalf("read %d wire bytes, wire cap is %d", wire.n, wireLimit)
	}
}

func TestEmptyGzipBodyIsNoBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var hasBody bool
	var length int64
	var encoding string
	engine := gin.New()
	engine.Use(requestBodyMiddleware(true))
	engine.POST("/oauth/register", func(c *gin.Context) {
		encoding = c.GetHeader("Content-Encoding")
		hasBody, length = requestHasBody(c), c.Request.ContentLength
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodPost, "/oauth/register", http.NoBody)
	req.Header.Set("Content-Encoding", "gzip")
	rr := httptest.NewRecorder()
	engine.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK || hasBody || length != 0 || encoding != "" {
		t.Fatalf("status %d, has body %v, length %d, Content-Encoding %q", rr.Code, hasBody, length, encoding)
	}
}

func TestGzipIsRefusedWithoutTheOptIn(t *testing.T) {
	gin.SetMode(gin.TestMode)
	reached := false
	engine := gin.New()
	engine.Use(requestBodyMiddleware(false))
	engine.POST("/oauth/register", func(c *gin.Context) {
		reached = true
		c.Status(http.StatusOK)
	})
	for _, encoding := range []string{"gzip", "x-gzip"} {
		for _, body := range []io.Reader{bytes.NewReader([]byte{0x1f, 0x8b}), http.NoBody} {
			req := httptest.NewRequest(http.MethodPost, "/oauth/register", body)
			req.Header.Set("Content-Encoding", encoding)
			rr := httptest.NewRecorder()
			engine.ServeHTTP(rr, req)
			if rr.Code != http.StatusUnsupportedMediaType || reached {
				t.Fatalf("%s: status %d, handler reached %v", encoding, rr.Code, reached)
			}
		}
	}
}
