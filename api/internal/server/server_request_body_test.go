package server_test

import (
	"bytes"
	"compress/gzip"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestRequestBodyLimits(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range []string{"/v1/auth/cli/exchange", "/oauth/register", "/v1/documents/" + e.doc.ID + "/comments"} {
		for _, length := range []int64{-1, 2 << 20} {
			reader := strings.NewReader(strings.Repeat(" ", 2<<20))
			req := httptest.NewRequest(http.MethodPost, path, reader)
			req.ContentLength = length
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Test-Principal", principalHeader(fixtureCommenter))
			rr := httptest.NewRecorder()
			e.h.ServeHTTP(rr, req)
			status := http.StatusRequestEntityTooLarge
			if length < 0 {
				status = http.StatusBadRequest
			}
			assertStatus(t, rr, status)
			if consumed := (2 << 20) - reader.Len(); consumed > (1<<20)+1 {
				t.Fatalf("read %d bytes beyond the request limit", consumed)
			}
		}
	}
}

func TestMultipartRequestBodyLimits(t *testing.T) {
	e := newTestEnv(t)
	body := "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"doc.html\"\r\nContent-Type: text/html\r\n\r\n" + strings.Repeat("x", 52<<20) + "\r\n--boundary--\r\n"
	for _, path := range []string{"/v1/documents", "/v1/documents/" + e.doc.ID + "/versions"} {
		for _, knownLength := range []bool{true, false} {
			reader := strings.NewReader(body)
			req := httptest.NewRequest(http.MethodPost, path, reader)
			if !knownLength {
				req.ContentLength = -1
			}
			req.Header.Set("Content-Type", "multipart/form-data; boundary=boundary")
			req.Header.Set("X-Test-Principal", principalHeader(fixtureEditor))
			rr := httptest.NewRecorder()
			e.h.ServeHTTP(rr, req)
			assertStatus(t, rr, http.StatusRequestEntityTooLarge)
			if consumed := len(body) - reader.Len(); consumed > (51<<20)+1 {
				t.Fatalf("read %d bytes beyond the request limit", consumed)
			}
		}
	}
}

func gzipBytes(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func commentJSON(e *testEnv, text string) string {
	return fmt.Sprintf(`{"version_id": %q, "body": %q, "anchor": {"quote": "fixture", "prefix": "", "suffix": ""}}`, e.ver.ID, text)
}

// newGzipTestEnv is a deployment that opts in to gzip request bodies.
func newGzipTestEnv(t *testing.T) *testEnv {
	t.Helper()
	return newConfiguredTestEnv(t, server.Config{Environment: "test", RequestGzip: true})
}

func TestGzipJSONBodyMatchesPlain(t *testing.T) {
	e := newGzipTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/comments"
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}
	plain := do(t, e.h, http.MethodPost, path, commentJSON(e, "plain"), headers)
	assertStatus(t, plain, http.StatusCreated)

	for _, encoding := range []string{"gzip", " GZip ", "x-gzip"} {
		gz := map[string]string{"Content-Encoding": encoding}
		for k, v := range headers {
			gz[k] = v
		}
		rr := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(gzipBytes(t, []byte(commentJSON(e, "compressed <script>alert(1)</script> ' OR 1=1 --")))), gz)
		assertStatus(t, rr, http.StatusCreated)
		if got := jsonField(t, rr.Body.Bytes(), "body"); got != "compressed <script>alert(1)</script> ' OR 1=1 --" {
			t.Fatalf("stored body = %q", got)
		}
	}

	identity := map[string]string{"Content-Encoding": "identity"}
	for k, v := range headers {
		identity[k] = v
	}
	assertStatus(t, do(t, e.h, http.MethodPost, path, commentJSON(e, "identity"), identity), http.StatusCreated)
}

func TestGzipMultipartUploadMatchesPlain(t *testing.T) {
	e := newGzipTestEnv(t)
	const html = "<html><body>Hello <script>x</script></body></html>"
	for _, path := range []string{"/v1/documents", "/v1/documents/" + e.doc.ID + "/versions"} {
		fields := map[string]string{"title": "Compressed"}
		if strings.HasSuffix(path, "/versions") {
			fields = map[string]string{"base_version_id": e.ver.ID, "change_summary": "gz"}
		}
		body, contentType := multipartBody(t, fields, "file", "doc.html", html)
		rr := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(gzipBytes(t, body.Bytes())), map[string]string{
			"Content-Type":     contentType,
			"Content-Encoding": "gzip",
			"X-Test-Principal": principalHeader(fixtureEditor),
		})
		assertStatus(t, rr, http.StatusCreated)
	}
}

func TestGzipMCPCall(t *testing.T) {
	e := newMCPOAuthTestEnvConfig(t, func(c *server.Config) { c.RequestGzip = true })
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	raw := marshalMCP(t, map[string]any{
		"jsonrpc": "2.0", "id": 7, "method": "tools/call",
		"params": map[string]any{"name": "whoami", "arguments": map[string]any{}},
	})
	rr := doRaw(t, e.h, http.MethodPost, "/mcp", bytes.NewReader(gzipBytes(t, []byte(raw))), map[string]string{
		"Authorization":    "Bearer " + token,
		"Content-Type":     "application/json",
		"Content-Encoding": "gzip",
		"Accept":           "application/json, text/event-stream",
	})
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), fixtureUser.Email) {
		t.Fatalf("whoami response = %s", rr.Body.String())
	}
}

func TestGzipBodyIsCappedAfterDecoding(t *testing.T) {
	e := newGzipTestEnv(t)

	// 2 MiB of spaces compresses to a few KiB, far below any wire limit.
	jsonBomb := gzipBytes(t, bytes.Repeat([]byte(" "), 2<<20))
	if len(jsonBomb) > 64<<10 {
		t.Fatalf("test body did not compress: %d bytes", len(jsonBomb))
	}
	for _, path := range []string{"/oauth/register", "/v1/documents/" + e.doc.ID + "/comments"} {
		plainReader := strings.NewReader(strings.Repeat(" ", 2<<20))
		plainReq := httptest.NewRequest(http.MethodPost, path, plainReader)
		plainReq.ContentLength = -1
		plainReq.Header.Set("Content-Type", "application/json")
		plainReq.Header.Set("X-Test-Principal", principalHeader(fixtureCommenter))
		plain := httptest.NewRecorder()
		e.h.ServeHTTP(plain, plainReq)

		gz := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(jsonBomb), map[string]string{
			"Content-Type": "application/json", "Content-Encoding": "gzip", "X-Test-Principal": principalHeader(fixtureCommenter),
		})
		if gz.Code != plain.Code {
			t.Fatalf("%s: gzip bomb status = %d, chunked plain over the cap = %d", path, gz.Code, plain.Code)
		}
		assertStatus(t, gz, http.StatusBadRequest)
	}

	multipartBomb := gzipBytes(t, []byte("--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"doc.html\"\r\nContent-Type: text/html\r\n\r\n"+strings.Repeat("x", 52<<20)+"\r\n--boundary--\r\n"))
	for _, path := range []string{"/v1/documents", "/v1/documents/" + e.doc.ID + "/versions"} {
		rr := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(multipartBomb), map[string]string{
			"Content-Type": "multipart/form-data; boundary=boundary", "Content-Encoding": "gzip", "X-Test-Principal": principalHeader(fixtureEditor),
		})
		assertStatus(t, rr, http.StatusRequestEntityTooLarge)
	}
}

func TestChunkedGzipOverWireLimitMatchesChunkedPlain(t *testing.T) {
	e := newGzipTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/comments"
	// Random bytes do not compress, so the wire stream itself exceeds the wire limit.
	noise := make([]byte, 3<<20)
	if _, err := rand.Read(noise); err != nil {
		t.Fatal(err)
	}
	stored := gzipBytes(t, noise)
	if len(stored) < 2<<20 {
		t.Fatalf("test body compressed to %d bytes", len(stored))
	}
	gzReader := bytes.NewReader(stored)
	req := httptest.NewRequest(http.MethodPost, path, gzReader)
	req.ContentLength = -1
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-Test-Principal", principalHeader(fixtureCommenter))
	gz := httptest.NewRecorder()
	e.h.ServeHTTP(gz, req)

	plainReq := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(noise))
	plainReq.ContentLength = -1
	plainReq.Header.Set("Content-Type", "application/json")
	plainReq.Header.Set("X-Test-Principal", principalHeader(fixtureCommenter))
	plain := httptest.NewRecorder()
	e.h.ServeHTTP(plain, plainReq)

	if gz.Code != plain.Code {
		t.Fatalf("chunked gzip status = %d, chunked plain = %d", gz.Code, plain.Code)
	}
	assertStatus(t, gz, http.StatusBadRequest)
	if consumed := len(stored) - gzReader.Len(); consumed > (1<<20)+(1<<10)+1024+1 {
		t.Fatalf("read %d wire bytes beyond the wire limit", consumed)
	}
}

type countingBody struct {
	io.Reader
	reads int
}

func (b *countingBody) Read(p []byte) (int, error) {
	b.reads++
	return b.Reader.Read(p)
}

func TestUnauthenticatedGzipBodyIsNeverRead(t *testing.T) {
	e := newGzipTestEnv(t)
	for _, path := range []string{"/v1/documents/" + e.doc.ID + "/comments", "/v1/documents"} {
		body := &countingBody{Reader: bytes.NewReader(gzipBytes(t, bytes.Repeat([]byte(" "), 1<<20)))}
		req := httptest.NewRequest(http.MethodPost, path, body)
		req.ContentLength = -1
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Content-Encoding", "gzip")
		rr := httptest.NewRecorder()
		e.h.ServeHTTP(rr, req)
		assertStatus(t, rr, http.StatusUnauthorized)
		if body.reads != 0 {
			t.Fatalf("%s: unauthenticated request read its body %d times", path, body.reads)
		}
	}
}

func TestGzipBodyWireLengthIsCapped(t *testing.T) {
	e := newGzipTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader("x"))
	req.ContentLength = 4 << 20
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusRequestEntityTooLarge)
}

func TestRepeatedContentEncodingHeadersAreRejected(t *testing.T) {
	e := newGzipTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/oauth/register", bytes.NewReader(gzipBytes(t, []byte(`{}`))))
	req.Header.Add("Content-Encoding", "gzip")
	req.Header.Add("Content-Encoding", "gzip")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusUnsupportedMediaType)
}

func TestMalformedGzipMatchesMalformedPlainBody(t *testing.T) {
	e := newGzipTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/comments"
	plain := do(t, e.h, http.MethodPost, path, "not json", map[string]string{
		"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, plain, http.StatusBadRequest)
	for name, body := range map[string][]byte{
		"not gzip":  []byte(`{"client_name":"x"}`),
		"empty":     {},
		"truncated": gzipBytes(t, []byte(commentJSON(e, "x")))[:6],
	} {
		t.Run(name, func(t *testing.T) {
			unauth := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(body), map[string]string{
				"Content-Type": "application/json", "Content-Encoding": "gzip",
			})
			assertStatus(t, unauth, http.StatusUnauthorized)
			authed := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(body), map[string]string{
				"Content-Type": "application/json", "Content-Encoding": "gzip", "X-Test-Principal": principalHeader(fixtureCommenter),
			})
			if authed.Code != plain.Code {
				t.Fatalf("malformed gzip status = %d, malformed plain = %d", authed.Code, plain.Code)
			}
		})
	}
}

func TestMalformedGzipMCPReachesTransport(t *testing.T) {
	e := newMCPOAuthTestEnvConfig(t, func(c *server.Config) { c.RequestGzip = true })
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	labels := map[string]string{"method": "transport", "outcome": "bad_request"}
	before := scrapeMetric(t, "slashdocs_mcp_requests_total", labels)
	rr := doRaw(t, e.h, http.MethodPost, "/mcp", strings.NewReader("not gzip"), map[string]string{
		"Authorization":    "Bearer " + token,
		"Content-Type":     "application/json",
		"Content-Encoding": "gzip",
		"Accept":           "application/json, text/event-stream",
	})
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "could not read MCP request body") {
		t.Fatalf("response = %s", rr.Body.String())
	}
	assertMetricValue(t, "slashdocs_mcp_requests_total", labels, before+1)
}

func TestUnsupportedRequestEncodingIsRejected(t *testing.T) {
	e := newGzipTestEnv(t)
	for _, encoding := range []string{"br", "deflate", "gzip, gzip", "gzip, br", "zstd"} {
		rr := doRaw(t, e.h, http.MethodPost, "/oauth/register", strings.NewReader(`{}`), map[string]string{
			"Content-Type": "application/json", "Content-Encoding": encoding,
		})
		assertStatus(t, rr, http.StatusUnsupportedMediaType)
		if strings.Contains(rr.Body.String(), encoding) {
			t.Fatalf("error body echoes the encoding: %s", rr.Body.String())
		}
	}
}

func TestGzipLiveTypingBodyIsDecodedAndCapped(t *testing.T) {
	e := newGzipTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/ops"
	headers := map[string]string{
		"Content-Type": "application/json", "Content-Encoding": "gzip",
		"X-Test-Principal": principalHeader(fixtureEditor),
	}
	opJSON := func(text string) []byte {
		b, err := json.Marshal(map[string]any{
			"base_seq": 1, "client_op_id": "op_gzip",
			"replacements": []map[string]any{replaceAt(fixtureHTML, "fixture", text, 0)},
		})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	// A body whose decoded size is under the cap is applied like a plain one.
	rr := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(gzipBytes(t, opJSON("typed <b>in</b> ' OR 1=1 --"))), headers)
	assertStatus(t, rr, http.StatusOK)
	var out repo.OperationResult
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if got, want := sourceAt(t, e, e.doc.ID, out.VersionID, out.Seq), "<html><body>typed <b>in</b> ' OR 1=1 --</body></html>"; got != want {
		t.Fatalf("source = %q, want %q", got, want)
	}

	// A small body that decodes past the cap is refused, as a plain chunked body of that size is.
	huge := opJSON(strings.Repeat("x", 2<<20))
	zipped := gzipBytes(t, huge)
	if len(zipped) > 64<<10 {
		t.Fatalf("test body did not compress: %d bytes", len(zipped))
	}
	headers["X-Test-Principal"] = principalHeader(fixtureOwner)
	over := doRaw(t, e.h, http.MethodPost, path, bytes.NewReader(zipped), headers)
	plainReq := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(huge))
	plainReq.ContentLength = -1
	plainReq.Header.Set("Content-Type", "application/json")
	plainReq.Header.Set("X-Test-Principal", principalHeader(fixtureOwner))
	plain := httptest.NewRecorder()
	e.h.ServeHTTP(plain, plainReq)
	if over.Code != plain.Code {
		t.Fatalf("oversized gzip status = %d, chunked plain = %d", over.Code, plain.Code)
	}
	assertStatus(t, over, http.StatusBadRequest)
}

// Slack signs the bytes that it sends, which are never gzip. A gzip body is
// checked and parsed as the same decoded bytes, so only a signature over those
// bytes passes and a signature over the compressed bytes does not.
func TestSlackSignatureCoversTheDecodedGzipBody(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{
		Environment: "test", AppOrigin: "https://docs.example", Deployment: server.DeploymentOrg, RequestGzip: true,
	}, server.WithSlackLinkPreviews(testSlackSecret, newFakeUnfurler(false)))
	body := `{"type":"url_verification","challenge":"abc123"}`
	zipped := gzipBytes(t, []byte(body))
	sign := func(signed []byte) map[string]string {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(testSlackSecret))
		mac.Write([]byte("v0:" + ts + ":"))
		mac.Write(signed)
		return map[string]string{
			"Content-Type": "application/json", "Content-Encoding": "gzip",
			"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": "v0=" + hex.EncodeToString(mac.Sum(nil)),
		}
	}

	ok := doRaw(t, e.h, http.MethodPost, "/v1/slack/events", bytes.NewReader(zipped), sign([]byte(body)))
	assertStatus(t, ok, http.StatusOK)
	assertJSON(t, ok.Body.Bytes(), `{"challenge":"abc123"}`)

	wire := doRaw(t, e.h, http.MethodPost, "/v1/slack/events", bytes.NewReader(zipped), sign(zipped))
	assertStatus(t, wire, http.StatusUnauthorized)
}

func TestGzipBodyIsRefusedWithoutTheOptIn(t *testing.T) {
	e := newTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/comments"
	body := &countingBody{Reader: bytes.NewReader(gzipBytes(t, []byte(commentJSON(e, "compressed"))))}
	req := httptest.NewRequest(http.MethodPost, path, body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-Test-Principal", principalHeader(fixtureCommenter))
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusUnsupportedMediaType)
	if body.reads != 0 {
		t.Fatalf("refused body was read %d times", body.reads)
	}
	assertStatus(t, do(t, e.h, http.MethodPost, path, commentJSON(e, "plain"), map[string]string{
		"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter),
	}), http.StatusCreated)
}
