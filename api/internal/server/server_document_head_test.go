package server_test

import (
	"cmp"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/googlegroups"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const testShell = `<!doctype html><html><head><title>slashdocs</title></head><body><div id="root"></div></body></html>`

func testFrontend() server.Option {
	return server.WithFrontend(fstest.MapFS{"index.html": {Data: []byte(testShell)}})
}

func newShellTestEnv(t *testing.T, cfg server.Config, extraOptions ...server.Option) *testEnv {
	t.Helper()
	return newConfiguredTestEnv(t, cfg, append(extraOptions, testFrontend())...)
}

func getPage(t *testing.T, h http.Handler, path string, p *auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	headers := map[string]string{}
	if p != nil {
		headers["X-Test-Principal"] = principalHeader(*p)
	}
	rr := do(t, h, http.MethodGet, path, "", headers)
	assertStatus(t, rr, http.StatusOK)
	return rr
}

func assertContains(t *testing.T, body string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(body, w) {
			t.Errorf("body lacks %q:\n%s", w, body)
		}
	}
}

func assertGenericShell(t *testing.T, rr *httptest.ResponseRecorder) {
	t.Helper()
	if rr.Body.String() != testShell {
		t.Errorf("want the generic shell, got:\n%s", rr.Body.String())
	}
}

// A document page depends on who asks, so shared caches must not keep it and
// the browser must revalidate it, but it may stay in the back/forward cache.
func assertPrivateNoCache(t *testing.T, rr *httptest.ResponseRecorder) {
	t.Helper()
	if got := rr.Header().Get("Cache-Control"); got != "private, no-cache" {
		t.Errorf("Cache-Control = %q, want private, no-cache", got)
	}
}

func TestDocumentPageHeadForReader(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://docs.example"})
	rr := getPage(t, e.h, "/app/d/"+e.doc.ID, &fixtureViewer)
	assertContains(t, rr.Body.String(),
		"<title>fixture · slashdocs</title>",
		`<meta name="description" content="By Owner · Updated `,
		`<meta property="og:title" content="fixture" />`,
		`<meta property="og:url" content="https://docs.example/app/d/`+e.doc.ID+`" />`,
		`<meta name="twitter:card" content="summary" />`,
	)
	assertPrivateNoCache(t, rr)
}

func TestDocumentPageHeadUsesAnExcerpt(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test"})
	doc, _, err := e.store.CreateDocument(context.Background(), fixtureOwner, "Launch plan",
		[]byte("<html><body><h1>Launch plan</h1><p>We ship on Friday.</p></body></html>"))
	if err != nil {
		t.Fatal(err)
	}
	body := getPage(t, e.h, "/app/d/"+doc.ID, &fixtureOwner).Body.String()
	assertContains(t, body, `<meta name="description" content="We ship on Friday." />`)
	if strings.Contains(body, "og:url") {
		t.Error("og:url without an app origin")
	}
}

func TestDocumentPageHeadForAnonymousReaderOfDocumentSharedWithAnyone(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test"})
	e.shareWithAnyone("viewer")
	assertContains(t, getPage(t, e.h, "/app/d/"+e.doc.ID, nil).Body.String(), "<title>fixture · slashdocs</title>")
}

func TestDocumentPageHeadForReaderOnAnOrgDeployment(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test", Deployment: server.DeploymentOrg, OrgName: "Acme"})
	e.shareWithAnyone("viewer")
	assertContains(t, getPage(t, e.h, "/app/d/"+e.doc.ID, &fixtureStranger).Body.String(), "<title>fixture · slashdocs</title>")
}

// blockingGroupDirectory answers like postgresGroupDirectory, except that
// while it is blocked it waits until the caller gives up.
type blockingGroupDirectory struct {
	*postgresGroupDirectory
	blocked atomic.Bool
}

func (d *blockingGroupDirectory) TransitiveGroupsForMember(ctx context.Context, email string) ([]googlegroups.GoogleGroup, error) {
	if d.blocked.Load() {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return d.postgresGroupDirectory.TransitiveGroupsForMember(ctx, email)
}

// The head uses Google Group memberships that are already cached and never
// asks the directory. A directory call that the page gave up on would count
// as a failure and make the app's next requests fail during the retry
// cooldown.
func TestDocumentPageHeadUsesCachedGroupMemberships(t *testing.T) {
	group := googlegroups.GoogleGroup{ID: "groups/platform", CustomerID: "C123", Email: "platform@example.com", Name: "Platform"}
	directory := &blockingGroupDirectory{postgresGroupDirectory: &postgresGroupDirectory{
		group:       group,
		memberships: map[string][]googlegroups.GoogleGroup{fixtureStranger.Email: {group}},
	}}
	e := newShellTestEnv(t, server.Config{
		Environment:         server.EnvProduction,
		Deployment:          server.DeploymentOrg,
		GoogleGroupsEnabled: true,
	}, server.WithGoogleGroupDirectory(directory))
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants",
		`{"principal":{"type":"google_group","email":"platform@example.com"},"role":"viewer"}`,
		map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureOwner)})
	assertStatus(t, rr, http.StatusCreated)

	directory.blocked.Store(true)
	assertGenericShell(t, getPage(t, e.h, "/app/d/"+e.doc.ID, &fixtureStranger))
	directory.blocked.Store(false)
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", map[string]string{"X-Test-Principal": principalHeader(fixtureStranger)})
	assertStatus(t, rr, http.StatusOK)
	assertContains(t, getPage(t, e.h, "/app/d/"+e.doc.ID, &fixtureStranger).Body.String(), "<title>fixture · slashdocs</title>")
}

// A CLI or an agent with an expired token must not read a document as
// anonymous; the page stays generic for it, as the API refuses it.
func TestDocumentPageKeepsTheGenericShellForAnInvalidBearerToken(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test"})
	e.shareWithAnyone("viewer")
	rr := do(t, e.h, http.MethodGet, "/app/d/"+e.doc.ID, "", map[string]string{"Authorization": "Bearer expired"})
	assertStatus(t, rr, http.StatusOK)
	assertGenericShell(t, rr)
}

func TestDocumentPageHeadEscapesTheTitle(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test"})
	if _, err := e.store.UpdateDocument(context.Background(), e.doc.ID, `Q3 "plan" <b>&`); err != nil {
		t.Fatal(err)
	}
	body := getPage(t, e.h, "/app/d/"+e.doc.ID, &fixtureOwner).Body.String()
	assertContains(t, body,
		"<title>Q3 &#34;plan&#34; &lt;b&gt;&amp; · slashdocs</title>",
		`<meta property="og:title" content="Q3 &#34;plan&#34; &lt;b&gt;&amp;" />`,
	)
	if strings.Contains(body, "<b>") {
		t.Error("unescaped title in the page")
	}
}

// Opening a document through the API adds a document shared with anyone to
// the reader's workspace. Loading its page must not, because the page loads
// before the reader has seen the document.
func TestDocumentPageHeadRecordsNothing(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test"})
	e.shareWithAnyone("viewer")
	stranger := map[string]string{"X-Test-Principal": principalHeader(fixtureStranger)}
	listed := func() bool {
		rr := do(t, e.h, http.MethodGet, "/v1/documents", "", stranger)
		assertStatus(t, rr, http.StatusOK)
		return strings.Contains(rr.Body.String(), e.doc.ID)
	}

	assertContains(t, getPage(t, e.h, "/app/d/"+e.doc.ID, &fixtureStranger).Body.String(), "<title>fixture · slashdocs</title>")
	if listed() {
		t.Fatal("loading the page added the document to the workspace")
	}
	assertStatus(t, do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", stranger), http.StatusOK)
	if !listed() {
		t.Fatal("opening the document did not add it to the workspace; this test cannot detect the side effect")
	}
}

func TestDocumentPageKeepsTheGenericShell(t *testing.T) {
	public := server.Config{Environment: "test"}
	org := server.Config{Environment: "test", Deployment: server.DeploymentOrg, OrgName: "Acme"}
	for _, tc := range []struct {
		name   string
		cfg    server.Config
		anyone bool
		doc    string
		caller *auth.Principal
	}{
		{"signed-in reader without a role", public, false, "", &fixtureStranger},
		{"anonymous, not shared with anyone", public, false, "", nil},
		{"anonymous on an org deployment", org, true, "", nil},
		{"missing document", public, false, "doc_missing", &fixtureOwner},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newShellTestEnv(t, tc.cfg)
			if tc.anyone {
				e.shareWithAnyone("viewer")
			}
			rr := getPage(t, e.h, "/app/d/"+cmp.Or(tc.doc, e.doc.ID), tc.caller)
			assertGenericShell(t, rr)
			assertPrivateNoCache(t, rr)
		})
	}
}

func TestOtherPagesKeepTheGenericShell(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test"})
	for _, path := range []string{"/app/documents", "/app/d/" + e.doc.ID + "/extra", "/"} {
		assertGenericShell(t, getPage(t, e.h, path, &fixtureOwner))
	}
}

// slowRoleRepo stands in for a database that does not answer.
type slowRoleRepo struct{ repo.Repository }

func (slowRoleRepo) RoleForDocument(ctx context.Context, _ auth.Principal, _ string) (repo.Role, error) {
	<-ctx.Done()
	return repo.RoleNone, ctx.Err()
}

// The page of the web app must load when the database is slow or down; the
// app then reports the problem itself.
func TestDocumentPageServesTheGenericShellWhenTheDatabaseIsSlow(t *testing.T) {
	e := newShellTestEnv(t, server.Config{Environment: "test"})
	h := server.New(server.Config{Environment: "test"},
		server.WithRepository(slowRoleRepo{e.store}),
		server.WithAuthenticator(testPrincipalAuth{}),
		testFrontend(),
	).Handler()
	start := time.Now()
	rr := getPage(t, h, "/app/d/"+e.doc.ID, &fixtureOwner)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("the page took %s", elapsed)
	}
	assertGenericShell(t, rr)
}
