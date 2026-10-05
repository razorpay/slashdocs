package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// errNoServer is returned when no server can be resolved from flags,
// environment, or config. There is deliberately no built-in default host: the
// CLI only ever talks to a server the user (or the server's own install.sh)
// pointed it at.
var errNoServer = errors.New("no aidocs server configured; pass --server <url> (e.g. --server https://aidocs.example.com), set AIDOCS_SERVER, or run `aidocs auth login <server>`")

// newHTTPClient builds an http.Client with explicit connection and overall
// timeouts so a slow or unreachable server can never hang the CLI.
func newHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:   true,
			TLSHandshakeTimeout: 10 * time.Second,
			IdleConnTimeout:     90 * time.Second,
		},
	}
}

var (
	// apiHTTPClient serves user-initiated API calls.
	apiHTTPClient = newHTTPClient(30 * time.Second)
	// updateHTTPClient serves the best-effort update check that runs after
	// commands; it stays short so it never noticeably delays the CLI.
	updateHTTPClient = newHTTPClient(5 * time.Second)
)

// Client is a thin HTTP transport for the aidocs API.
type Client struct {
	Base, Token string
	HTTP        *http.Client
}

// client builds a Client from flags, environment, and the active config context.
func client(g *globals) (*Client, error) {
	srv := first(g.server, os.Getenv("AIDOCS_SERVER"))
	tok := first(g.token, os.Getenv("AIDOCS_TOKEN"))
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}
	if srv == "" && cfg.ActiveContext != "" {
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
	return &Client{Base: normalizeServer(srv), Token: tok, HTTP: apiHTTPClient}, nil
}

// APIError represents a non-2xx response from the API. Details carries the
// server's structured "details" object verbatim; it is what a caller acts on
// (current_version_id on a 409 version_conflict), so it is never dropped.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details any
	Body    string
}

func (e *APIError) Error() string {
	msg := e.Message
	if hint := e.hint(); hint != "" {
		msg += " (" + hint + ")"
	}
	if e.Code != "" {
		return fmt.Sprintf("api %d %s: %s", e.Status, e.Code, msg)
	}
	return fmt.Sprintf("api %d: %s", e.Status, msg)
}

// hint turns the server's details into an actionable sentence, so a caller who
// is not using --json still learns how to recover from the human text alone.
func (e *APIError) hint() string {
	if e.Code == "version_conflict" {
		if id := detailString(e.Details, "current_version_id"); id != "" {
			return "the current version is " + id + "; rebase on it and retry with --base-version " + id
		}
	}
	return ""
}

// detailString reads a string off the server's details object.
func detailString(details any, key string) string {
	m, _ := details.(map[string]any)
	s, _ := m[key].(string)
	return s
}

func (c *Client) do(method, path string, body io.Reader, ct string) ([]byte, error) {
	req, err := http.NewRequest(method, c.Base+path, body)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = res.Body.Close()
	}()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		ae := &APIError{Status: res.StatusCode, Message: strings.TrimSpace(string(b)), Body: string(b)}
		var payload struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Details any    `json:"details"`
			} `json:"error"`
		}
		if json.Unmarshal(b, &payload) == nil && payload.Error.Message != "" {
			ae.Code = payload.Error.Code
			ae.Message = payload.Error.Message
			ae.Details = payload.Error.Details
		}
		return nil, ae
	}
	return b, nil
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
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			return nil, err
		}
	}
	fw, err := mw.CreateFormFile(fileField, fileName)
	if err != nil {
		return nil, err
	}
	if _, err := fw.Write(data); err != nil {
		return nil, err
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	return c.do("POST", path, &buf, mw.FormDataContentType())
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
