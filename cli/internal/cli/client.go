package cli

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// errNoServer is returned when no server can be resolved from flags,
// environment, or config. There is deliberately no built-in default host: the
// CLI only ever talks to a server the user (or the server's own install.sh)
// pointed it at.
var errNoServer = errors.New("no slashdocs server configured; pass --server <url> (e.g. --server https://slashdocs.example.com), set SLASHDOCS_SERVER, or run `slashdocs auth login <server>`")

// newHTTPClient builds an http.Client with explicit connection and overall
// timeouts so a slow or unreachable server can never hang the CLI.
func newHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout:       timeout,
		CheckRedirect: keepCredentialsOnMove,
		Transport: &http.Transport{
			Proxy: func(r *http.Request) (*url.URL, error) {
				if isLoopbackHost(r.URL.Hostname()) {
					return nil, nil // a proxy cannot reach this machine
				}
				return http.ProxyFromEnvironment(r)
			},
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return dialer.DialContext(ctx, network, localhostAddr(addr))
			},
			ForceAttemptHTTP2:   true,
			TLSHandshakeTimeout: 10 * time.Second,
			IdleConnTimeout:     90 * time.Second,
		},
	}
}

// localhostAddr sends a *.localhost name to this machine, as RFC 6761 tells
// and browsers do. The resolver of Go does not do it on all systems.
func localhostAddr(addr string) string {
	if host, port, err := net.SplitHostPort(addr); err == nil && isLocalhostName(host) {
		return net.JoinHostPort("127.0.0.1", port)
	}
	return addr
}

var (
	// apiHTTPClient serves user-initiated API calls.
	apiHTTPClient = newHTTPClient(30 * time.Second)
	// updateHTTPClient serves the best-effort update check that runs after
	// commands; it stays short so it never noticeably delays the CLI.
	updateHTTPClient = newHTTPClient(5 * time.Second)
)

// keepCredentialsOnMove follows redirects like the default policy. A server
// that moved permanently keeps the caller's credentials: Go removes them on a
// redirect to another host, so they are added back, except on a downgrade
// from HTTPS to HTTP.
func keepCredentialsOnMove(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	auth := via[0].Header.Get("Authorization")
	if auth != "" && movedPermanently(req) && (req.URL.Scheme == "https" || via[0].URL.Scheme == "http") {
		//nolint:gosec // G119: intended; only a permanent move of the server the user configured keeps the token.
		req.Header.Set("Authorization", auth)
	}
	return nil
}

// movedPermanently reports whether req follows a permanent redirect.
func movedPermanently(req *http.Request) bool {
	return req.Response != nil && (req.Response.StatusCode == http.StatusMovedPermanently || req.Response.StatusCode == http.StatusPermanentRedirect)
}

// Client is a thin HTTP transport for the slashdocs API.
type Client struct {
	Base, Token string
	HTTP        *http.Client
	// saved is true when Base comes from the saved config, which the client
	// updates when the server moves.
	saved bool

	featuresMu   sync.Mutex
	featuresBase string
	features     *serverFeatures
}

// serverFeatures is the part of the discovery document the CLI acts on.
type serverFeatures struct {
	RequestEncodings []string `json:"request_encodings"`
	CompressRequests bool     `json:"compress_requests"`
}

// serverFeatures fetches the discovery document once per base URL, so a
// client that follows a server move asks the new server. A server that does
// not serve it, or serves something else, counts as having no features, so
// such servers get requests exactly as older CLIs sent them.
func (c *Client) serverFeatures() serverFeatures {
	c.featuresMu.Lock()
	defer c.featuresMu.Unlock()
	if c.features == nil || c.featuresBase != c.Base {
		c.features = &serverFeatures{}
		c.featuresBase = c.Base
		c.fetchFeatures(c.features)
	}
	return *c.features
}

func (c *Client) fetchFeatures(into *serverFeatures) {
	req, err := http.NewRequest(http.MethodGet, c.Base+"/.well-known/slashdocs.json", nil)
	if err != nil {
		return
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return
	}
	var f serverFeatures
	if json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&f) == nil {
		*into = f
	}
}

// compressesBodies reports whether the server asks for gzip request bodies.
// The CLI runs one command per process, so a change of the server setting
// applies to the next command.
func (c *Client) compressesBodies() bool {
	f := c.serverFeatures()
	return f.CompressRequests && slices.Contains(f.RequestEncodings, "gzip")
}

// stopCompressing follows a server that refused a gzip body: its setting
// changed after this process read discovery.
func (c *Client) stopCompressing() {
	c.featuresMu.Lock()
	defer c.featuresMu.Unlock()
	if c.features != nil {
		c.features.CompressRequests = false
	}
}

// refusedEncoding reports a server that does not accept the body's
// Content-Encoding. Handlers also answer 415 for a wrong Content-Type, which
// sending the body plain would not fix.
func refusedEncoding(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == http.StatusUnsupportedMediaType && ae.Code == "unsupported_encoding"
}

// newGzipWriter uses the best level: lower levels write more short bodies as
// stored blocks, which leave the text readable on the wire. Even the best level
// stores a short body with little repetition.
func newGzipWriter(w io.Writer) (*gzip.Writer, error) {
	return gzip.NewWriterLevel(w, gzip.BestCompression)
}

// gzipBody compresses body into memory. Compressed documents are small, and an
// in-memory body lets the HTTP client resend it after a redirect.
func gzipBody(body io.Reader) (*bytes.Buffer, error) {
	var buf bytes.Buffer
	zw, err := newGzipWriter(&buf)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(zw, body); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return &buf, nil
}

// client builds a Client from flags, environment, and the active config context.
func client(g *globals) (*Client, error) {
	srv := first(g.server, env("SLASHDOCS_SERVER"))
	tok := first(g.token, env("SLASHDOCS_TOKEN"))
	if g.local {
		// slashdocs local needs no token, so no token goes to it.
		return &Client{Base: srv, HTTP: apiHTTPClient}, nil
	}
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}
	saved := srv == "" && cfg.ActiveContext != ""
	if saved {
		srv = cfg.Contexts[cfg.ActiveContext].serverOr(srv)
	}
	if srv == "" {
		return nil, errNoServer
	}
	// Look up a stored token for whichever server we're targeting, whether it
	// came from a flag/env or the active context, so an explicit --server that
	// the user is logged into still authenticates.
	if tok == "" {
		if c := cfg.Contexts[ctxName(srv)]; c != nil {
			tok = credentialToken(ctxName(srv), c.Credential)
		}
	}
	return &Client{Base: normalizeServer(srv), Token: tok, HTTP: apiHTTPClient, saved: saved}, nil
}

// APIError represents a non-2xx response from the API. Details are the
// "details" of the error response, such as current_version_id on a
// version_conflict.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
	Body    string
}

func (e *APIError) Error() string {
	text := fmt.Sprintf("api %d", e.Status)
	if e.Code != "" {
		text += " " + e.Code
	}
	text += ": " + e.Message
	if details := scalarDetails(e.Details); details != "" {
		text += " (" + details + ")"
	}
	return text
}

// scalarDetails writes the scalar values of details as key=value pairs, in key
// order, so the human error text names what a caller needs to recover.
func scalarDetails(details map[string]any) string {
	var parts []string
	for _, k := range slices.Sorted(maps.Keys(details)) {
		switch v := details[k].(type) {
		case string, float64, bool:
			parts = append(parts, fmt.Sprintf("%s=%v", k, v))
		}
	}
	return strings.Join(parts, " ")
}

func (c *Client) do(method, path string, body io.Reader, ct string) ([]byte, error) {
	b, _, err := c.doResponse(method, path, body, ct)
	return b, err
}

// doResponse is do for a caller that also reads the response headers.
func (c *Client) doResponse(method, path string, body io.Reader, ct string) ([]byte, http.Header, error) {
	if body == nil || !c.compressesBodies() {
		return c.send(method, path, body, ct, false)
	}
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, nil, err
	}
	zipped, err := gzipBody(bytes.NewReader(raw))
	if err != nil {
		return nil, nil, err
	}
	b, h, err := c.send(method, path, zipped, ct, true)
	if refusedEncoding(err) {
		c.stopCompressing()
		return c.send(method, path, bytes.NewReader(raw), ct, false)
	}
	return b, h, err
}

// send issues one request; encoded says body already holds gzip bytes.
func (c *Client) send(method, path string, body io.Reader, ct string, encoded bool) ([]byte, http.Header, error) {
	req, err := http.NewRequest(method, c.Base+path, body)
	if err != nil {
		return nil, nil, err
	}
	if encoded {
		req.Header.Set("Content-Encoding", "gzip")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		_ = res.Body.Close()
	}()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, nil, err
	}
	if res.StatusCode < 400 {
		c.followMove(res.Request)
	}
	if res.StatusCode >= 400 {
		ae := &APIError{Status: res.StatusCode, Message: strings.TrimSpace(string(b)), Body: string(b)}
		var payload struct {
			Error struct {
				Code    string         `json:"code"`
				Message string         `json:"message"`
				Details map[string]any `json:"details"`
			} `json:"error"`
		}
		if json.Unmarshal(b, &payload) == nil && payload.Error.Message != "" {
			ae.Code = payload.Error.Code
			ae.Message = payload.Error.Message
			ae.Details = payload.Error.Details
		}
		return nil, nil, ae
	}
	return b, res.Header, nil
}

// followMove saves the new server origin after the saved server answered with
// a permanent redirect to another origin, so later commands go there directly.
func (c *Client) followMove(final *http.Request) {
	base, err := url.Parse(c.Base)
	if !c.saved || err != nil || !movedPermanently(final) || final.URL.Host == base.Host {
		return
	}
	moved := final.URL.Scheme + "://" + final.URL.Host + base.Path
	if err := moveContext(c.Base, moved); err != nil {
		fmt.Fprintf(os.Stderr, "The slashdocs server moved to %s, but the CLI config was not updated: %v\n", moved, err)
		return
	}
	fmt.Fprintf(os.Stderr, "The slashdocs server moved to %s. The CLI config now uses it.\n", moved)
	c.Base = moved
}

func (c *Client) doJSON(method, path string, in any) ([]byte, error) {
	var r io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	return c.do(method, path, r, "application/json")
}

func (c *Client) multipart(path string, fields map[string]string, fileField, fileName string, data []byte) ([]byte, error) {
	gzipped := c.compressesBodies()
	body, ct, err := multipartBody(fields, fileField, fileName, data, gzipped)
	if err != nil {
		return nil, err
	}
	b, _, err := c.send("POST", path, body, ct, gzipped)
	if gzipped && refusedEncoding(err) {
		c.stopCompressing()
		if body, ct, err = multipartBody(fields, fileField, fileName, data, false); err != nil {
			return nil, err
		}
		b, _, err = c.send("POST", path, body, ct, false)
	}
	return b, err
}

// multipartBody builds an upload body and its Content-Type. With gzipped, the
// parts go straight into the compressor so the raw upload is never buffered
// twice.
func multipartBody(fields map[string]string, fileField, fileName string, data []byte, gzipped bool) (*bytes.Buffer, string, error) {
	var buf bytes.Buffer
	var out io.Writer = &buf
	var zw *gzip.Writer
	if gzipped {
		var err error
		if zw, err = newGzipWriter(&buf); err != nil {
			return nil, "", err
		}
		out = zw
	}
	mw := multipart.NewWriter(out)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			return nil, "", err
		}
	}
	fw, err := mw.CreateFormFile(fileField, fileName)
	if err != nil {
		return nil, "", err
	}
	if _, err := fw.Write(data); err != nil {
		return nil, "", err
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	if gzipped {
		if err := zw.Close(); err != nil {
			return nil, "", err
		}
	}
	return &buf, mw.FormDataContentType(), nil
}

// apiPath builds a request path, URL-escaping every caller-supplied ID segment
// so raw IDs cannot break out of their path position.
func apiPath(format string, ids ...string) string {
	esc := make([]any, len(ids))
	for i, id := range ids {
		esc[i] = url.PathEscape(id)
	}
	return fmt.Sprintf(format, esc...)
}

// browserURL builds an absolute URL from a server base and a path template,
// URL-escaping every ID segment.
func browserURL(base, format string, ids ...string) string {
	return strings.TrimRight(base, "/") + apiPath(format, ids...)
}
