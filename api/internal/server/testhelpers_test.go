package server_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/kvevents"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

// testPrincipalAuth is a test-only authenticator that trusts the
// X-Test-Principal header. It is defined here (in the server test package)
// rather than in api/internal/auth so it never ships in a production binary,
// even without a build tag. The format is:
//
//	<type>:<id>[:<email>[:<name>]]
type testPrincipalAuth struct{}

func (testPrincipalAuth) Authenticate(r *http.Request) (*auth.Principal, error) {
	raw := r.Header.Get("X-Test-Principal")
	if raw == "" {
		return nil, auth.ErrUnauthorized
	}
	parts := strings.Split(raw, ":")
	if len(parts) < 2 {
		return nil, auth.ErrUnauthorized
	}
	p := &auth.Principal{Type: auth.PrincipalType(parts[0]), ID: parts[1]}
	if len(parts) >= 3 {
		p.Email = parts[2]
	}
	if len(parts) >= 4 {
		p.Name = parts[3]
	}
	return p, nil
}

// Canonical fixture principals. Each seeded user has a matching
// X-Test-Principal header value so tests read naturally.
var (
	fixtureOwner     = auth.Principal{Type: auth.PrincipalUser, ID: "owner_1", Email: "owner@example.com", Name: "Owner"}
	fixtureEditor    = auth.Principal{Type: auth.PrincipalUser, ID: "editor_1", Email: "editor@example.com", Name: "Editor"}
	fixtureCommenter = auth.Principal{Type: auth.PrincipalUser, ID: "commenter_1", Email: "commenter@example.com", Name: "Commenter"}
	fixtureViewer    = auth.Principal{Type: auth.PrincipalUser, ID: "viewer_1", Email: "viewer@example.com", Name: "Viewer"}
	fixtureUser      = auth.Principal{Type: auth.PrincipalUser, ID: "usr_1", Email: "anurag@example.com", Name: "Anurag"}
	fixtureAttacker  = auth.Principal{Type: auth.PrincipalUser, ID: "attacker_1", Email: "attacker@example.com", Name: "Attacker"}
	fixtureStranger  = auth.Principal{Type: auth.PrincipalUser, ID: "usr_stranger", Email: "stranger@example.com", Name: "Stranger"}
)

func principalHeader(p auth.Principal) string {
	return strings.Join([]string{string(p.Type), p.ID, p.Email, p.Name}, ":")
}

// testEnv wires a server handler to a real Postgres-backed repository seeded
// with the canonical fixture graph: a document (with one version and one open
// comment by the commenter), a service account, and viewer/commenter/editor
// grants on the document.
type testEnv struct {
	t     *testing.T
	h     http.Handler
	store *pgrepo.Store

	doc repo.Document
	ver repo.Version
	cmt repo.Comment
	sa  repo.ServiceAccount
}

func newTestEnv(t *testing.T) *testEnv {
	return newConfiguredTestEnv(t, server.Config{Environment: "test"})
}

func newConfiguredTestEnv(t *testing.T, cfg server.Config, extraOptions ...server.Option) *testEnv {
	t.Helper()
	store := newTestStore(t)
	ctx := context.Background()
	e := &testEnv{t: t, store: store}

	for _, p := range []auth.Principal{fixtureOwner, fixtureEditor, fixtureCommenter, fixtureViewer, fixtureUser, fixtureAttacker, fixtureStranger} {
		e.seedUser(p)
	}

	var err error
	e.doc, e.ver, err = store.CreateDocument(ctx, fixtureOwner, "fixture", []byte("<html><body>fixture</body></html>"))
	if err != nil {
		t.Fatalf("seed document: %v", err)
	}
	for _, g := range []struct {
		p    auth.Principal
		role repo.Role
	}{{fixtureEditor, repo.RoleEditor}, {fixtureCommenter, repo.RoleCommenter}, {fixtureViewer, repo.RoleViewer}} {
		if _, err := store.CreateGrant(ctx, "document", e.doc.ID, g.p, g.role, fixtureOwner); err != nil {
			t.Fatalf("seed grant: %v", err)
		}
	}
	e.cmt, err = store.CreateComment(ctx, e.doc.ID, e.ver.ID, "original", repo.Anchor{Quote: "fixture"}, fixtureCommenter, nil)
	if err != nil {
		t.Fatalf("seed comment: %v", err)
	}
	e.sa, err = store.CreateServiceAccount(ctx, fixtureOwner, "fixture")
	if err != nil {
		t.Fatalf("seed service account: %v", err)
	}

	eventBroker, err := kvevents.New(context.Background(), kvevents.Config{
		Mode:         kvevents.ModePoll,
		PollInterval: 5 * time.Millisecond,
	}, store, nil)
	if err != nil {
		t.Fatalf("create test KV event broker: %v", err)
	}
	t.Cleanup(eventBroker.Close)
	options := []server.Option{
		server.WithRepository(store),
		server.WithAuthenticator(testPrincipalAuth{}),
		server.WithDocumentKVEvents(eventBroker),
	}
	options = append(options, extraOptions...)
	e.h = server.New(cfg, options...).Handler()
	return e
}

// seedUser inserts a user row so foreign keys (documents, grants, workspace
// entries) resolve for the matching X-Test-Principal header.
func (e *testEnv) seedUser(p auth.Principal) {
	e.t.Helper()
	if _, err := e.store.UpsertGoogleUser(context.Background(), p.ID, p.Email, p.Name, "sub-"+p.ID, ""); err != nil {
		e.t.Fatalf("seed user %s: %v", p.ID, err)
	}
}

// createDocument uploads a document as the given principal and returns the
// created document id and version id.
func (e *testEnv) createDocument(title, html string, p auth.Principal) (docID, verID string) {
	e.t.Helper()
	body, contentType := multipartBody(e.t, map[string]string{"title": title}, "file", "doc.html", html)
	rr := doRaw(e.t, e.h, http.MethodPost, "/v1/documents", body, map[string]string{
		"Content-Type":     contentType,
		"X-Test-Principal": principalHeader(p),
	})
	assertStatus(e.t, rr, http.StatusCreated)
	var out struct {
		ID               string `json:"id"`
		CurrentVersionID string `json:"current_version_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		e.t.Fatalf("bad create document response: %v", err)
	}
	return out.ID, out.CurrentVersionID
}

// newTestStore connects a Postgres store to a fresh migrated test database.
func newTestStore(t *testing.T) *pgrepo.Store {
	t.Helper()
	store, err := pgrepo.Connect(context.Background(), testdb.New(t))
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

func newOAuthTestServer(t *testing.T) http.Handler {
	return newOAuthTestServerForOrigin(t, "https://app.example")
}

func newOAuthTestServerForOrigin(t *testing.T, appOrigin string) http.Handler {
	return newOIDCTestServerForOrigin(t, appOrigin, "https://accounts.example", "", nil)
}

func newOIDCTestServer(t *testing.T, issuer, deployment string, allowedDomains []string) http.Handler {
	return newOIDCTestServerForOrigin(t, "https://app.example", issuer, deployment, allowedDomains)
}

func newOIDCTestServerForOrigin(t *testing.T, appOrigin, issuer, deployment string, allowedDomains []string) http.Handler {
	t.Helper()
	return server.New(server.Config{
		Environment:         "test",
		AppOrigin:           appOrigin,
		SessionSecret:       oauthTestSigningMaterial,
		Deployment:          deployment,
		AllowedOAuthDomains: allowedDomains,
		OIDC: auth.OIDC{
			Issuer: issuer,
			Config: &oauth2.Config{
				ClientID:    "client-id",
				RedirectURL: appOrigin + "/v1/auth/google/callback",
				Endpoint: oauth2.Endpoint{
					AuthURL:  issuer + "/auth",
					TokenURL: issuer + "/token",
				},
			},
		},
	}, server.WithRepository(newTestStore(t)), server.WithAuthenticator(testPrincipalAuth{})).Handler()
}

func do(t *testing.T, h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	return doRaw(t, h, method, path, strings.NewReader(body), headers)
}

func doRaw(t *testing.T, h http.Handler, method, path string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func multipartBody(t *testing.T, fields map[string]string, fileField, fileName, fileBody string) (*bytes.Buffer, string) {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := w.CreateFormFile(fileField, fileName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte(fileBody)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &b, w.FormDataContentType()
}

func scrapeMetric(t *testing.T, name string, labels map[string]string) float64 {
	t.Helper()
	// Metrics are served on a separate listener; the package-global registry is
	// shared, so scrape MetricsHandler directly.
	rr := do(t, server.MetricsHandler(), http.MethodGet, "/metrics", "", nil)
	assertStatus(t, rr, http.StatusOK)
	for _, line := range strings.Split(rr.Body.String(), "\n") {
		if line == "" || strings.HasPrefix(line, "#") || !strings.HasPrefix(line, name) {
			continue
		}
		metric, value, ok := strings.Cut(line, " ")
		if !ok || !metricLabelsMatch(metric, name, labels) {
			continue
		}
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			t.Fatalf("parse metric %q value %q: %v", name, value, err)
		}
		return f
	}
	return 0
}

func metricLabelsMatch(metric, name string, want map[string]string) bool {
	if metric == name {
		return len(want) == 0
	}
	if !strings.HasPrefix(metric, name+"{") || !strings.HasSuffix(metric, "}") {
		return false
	}
	labels := map[string]string{}
	for _, part := range strings.Split(strings.TrimSuffix(strings.TrimPrefix(metric, name+"{"), "}"), ",") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			return false
		}
		labels[k] = strings.Trim(v, "\"")
	}
	for k, v := range want {
		if labels[k] != v {
			return false
		}
	}
	return true
}

func assertStatus(t *testing.T, rr *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rr.Code != want {
		t.Fatalf("status = %d, want %d; body=%s", rr.Code, want, rr.Body.String())
	}
}

func assertJSON(t *testing.T, got []byte, want string) {
	t.Helper()
	var gotAny any
	if err := json.Unmarshal(got, &gotAny); err != nil {
		t.Fatalf("response is not JSON: %v; body=%s", err, string(got))
	}
	var wantAny any
	if err := json.Unmarshal([]byte(want), &wantAny); err != nil {
		t.Fatalf("bad test JSON: %v", err)
	}
	gotNorm, _ := json.Marshal(gotAny)
	wantNorm, _ := json.Marshal(wantAny)
	if string(gotNorm) != string(wantNorm) {
		t.Fatalf("json mismatch\n got: %s\nwant: %s", gotNorm, wantNorm)
	}
}

// jsonField extracts a top-level string field from a JSON response body.
func jsonField(t *testing.T, body []byte, field string) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("response is not JSON: %v; body=%s", err, body)
	}
	v, _ := m[field].(string)
	if v == "" {
		t.Fatalf("response field %q missing or empty: %s", field, body)
	}
	return v
}

func readDocumentKVSSEEvent(t *testing.T, r *bufio.Reader) repo.DocumentKVEvent {
	t.Helper()
	for {
		lines := readSSEBlock(t, r)
		eventID := ""
		for _, line := range lines {
			if strings.HasPrefix(line, "id: ") {
				eventID = strings.TrimPrefix(line, "id: ")
			}
		}
		for _, line := range lines {
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var event repo.DocumentKVEvent
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
				t.Fatalf("bad SSE event JSON %q: %v", line, err)
			}
			if want := strconv.FormatInt(event.Revision, 10); eventID != want {
				t.Fatalf("SSE event id = %q, want revision %q", eventID, want)
			}
			return event
		}
	}
}

func readSSEComment(t *testing.T, r *bufio.Reader, want string) {
	t.Helper()
	for {
		for _, line := range readSSEBlock(t, r) {
			if line == want {
				return
			}
		}
	}
}

func readSSEBlock(t *testing.T, r *bufio.Reader) []string {
	t.Helper()
	var lines []string
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE stream: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			return lines
		}
		lines = append(lines, line)
	}
}
