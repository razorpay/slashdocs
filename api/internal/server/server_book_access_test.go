package server_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/server"
)

// chapterRoute is one of the routes that name a chapter.
type chapterRoute struct {
	name   string
	method string
	path   func(doc string) string
	body   func(t *testing.T, doc, ver string) string
}

var chapterRoutes = []chapterRoute{
	{"position", http.MethodPut, func(string) string { return "/position" },
		func(t *testing.T, doc, ver string) string { return positionBody(t, position(doc, ver, "", time.Now())) }},
	{"open", http.MethodPost, func(doc string) string { return "/chapters/" + doc + "/open" },
		func(_ *testing.T, _, ver string) string { return `{"version_id":"` + ver + `"}` }},
	{"progress", http.MethodPost, func(doc string) string { return "/chapters/" + doc + "/progress" },
		func(_ *testing.T, _, ver string) string {
			return `{"progression":1,"reached_end":true,"version_id":"` + ver + `"}`
		}},
	{"done", http.MethodPut, func(doc string) string { return "/chapters/" + doc + "/done" },
		func(*testing.T, string, string) string { return `{"done":true}` }},
	{"seen", http.MethodPost, func(doc string) string { return "/chapters/" + doc + "/seen" },
		func(_ *testing.T, _, ver string) string { return `{"version_id":"` + ver + `"}` }},
	{"changes", http.MethodGet, func(doc string) string { return "/chapters/" + doc + "/changes" },
		func(*testing.T, string, string) string { return "" }},
}

// Every route that names a chapter answers 404, with nothing about the
// document in the body, for a chapter the reader cannot open, for a document
// the reader can open in another folder, and for a document of the book's
// folder that the outline does not place (R24).
func TestChapterRoutesAnswerNotFoundOutsideTheReadersBook(t *testing.T) {
	f := newReadingFixture(t)
	// The viewer owns a document in no folder.
	other, otherVer := f.e.createDocument("Viewer diary", readingV1, fixtureViewer)
	// A document in the book's folder that the outline does not place.
	loose, looseVer := f.e.createDocument("Loose notes", readingV1, fixtureOwner)
	bkMoveIn(t, f.e, f.folderID, loose, f.owner)
	f.grant(t, loose, fixtureViewer)
	rr := do(t, f.e.h, http.MethodGet, "/v1/documents/"+loose, "", bkHeaders(f.viewer))
	assertStatus(t, rr, http.StatusOK)

	cases := []struct{ name, doc, ver, title string }{
		{"hidden chapter", f.ch3, f.ch3v1, "Secrets"},
		{"document in another folder", other, otherVer, "Viewer diary"},
		{"document not in the outline", loose, looseVer, "Loose notes"},
	}
	for _, r := range chapterRoutes {
		for _, tc := range cases {
			t.Run(r.name+"/"+tc.name, func(t *testing.T) {
				body := f.expect(t, r.method, r.path(tc.doc), r.body(t, tc.doc, tc.ver), f.viewer, http.StatusNotFound)
				if strings.Contains(string(body), tc.title) || strings.Contains(string(body), tc.doc) {
					t.Fatalf("404 leaks the document: %s", body)
				}
			})
		}
	}
	// Nothing was written for any of them.
	s := f.state(t, f.viewer)
	if len(s.Positions) != 0 {
		t.Fatalf("positions = %+v, want none", s.Positions)
	}
}

// groupsDownAuth authenticates like testPrincipalAuth, but as if Google Group
// membership could not be resolved.
type groupsDownAuth struct{}

func (groupsDownAuth) Authenticate(r *http.Request) (*auth.Principal, error) {
	p, err := testPrincipalAuth{}.Authenticate(r)
	if err != nil {
		return nil, err
	}
	if p.Type == auth.PrincipalUser {
		p.GoogleGroupMembershipState = auth.GoogleGroupMembershipUnavailable
	}
	return p, nil
}

// While group membership cannot be resolved, a book answers 503 rather than
// a smaller book or a 404: a group grant may be the one that lets the caller
// read it.
func TestBookRoutesAnswer503WhenGroupsAreUnavailable(t *testing.T) {
	f := newReadingFixture(t)
	h := server.New(server.Config{Environment: "test", BooksEnabled: true},
		server.WithRepository(f.e.store), server.WithAuthenticator(groupsDownAuth{})).Handler()
	stranger := principalHeader(fixtureStranger)
	check := func(method, path, body, principal string) {
		t.Helper()
		rr := do(t, h, method, "/v1/books/"+f.bookID+path, body, bkHeaders(principal))
		assertStatus(t, rr, http.StatusServiceUnavailable)
		if got := errorCode(t, rr.Body.Bytes()); got != "group_membership_unavailable" {
			t.Fatalf("%s %s: error.code = %q, want group_membership_unavailable", method, path, got)
		}
	}
	// The views that list the book's chapters.
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, ""}, {http.MethodGet, "/llms.txt"}, {http.MethodGet, "/state"},
		{http.MethodGet, "/search?q=costs"}, {http.MethodPost, "/seen"},
	} {
		check(r.method, r.path, "", f.viewer)
	}
	// A chapter the caller has no direct role on.
	for _, r := range chapterRoutes {
		check(r.method, r.path(f.ch3), r.body(t, f.ch3, f.ch3v1), f.viewer)
	}
	// The editor routes, for a caller with no direct role on the folder.
	for _, path := range []string{"/outline", "/outline/versions", "/status"} {
		check(http.MethodGet, path, "", stranger)
	}
	// A direct grant still works.
	rr := do(t, h, http.MethodPost, "/v1/books/"+f.bookID+"/chapters/"+f.ch1+"/open", `{"version_id":"`+f.ch1v1+`"}`, bkHeaders(f.viewer))
	assertStatus(t, rr, http.StatusNoContent)
}

// Each group of book routes has its own per-user budget per minute. Spending
// it answers 429 on every route of the group and leaves the others alone.
func TestBookRoutesAreRateLimited(t *testing.T) {
	f := newReadingFixture(t)
	ch := "/chapters/" + f.ch1
	type route struct{ method, path, body string }
	groups := []struct {
		name   string
		budget int
		routes []route
	}{
		{"reads", 120, []route{
			{http.MethodGet, "", ""},
			{http.MethodGet, "/llms.txt", ""},
			{http.MethodGet, "/state", ""},
			{http.MethodGet, "/search?q=costs", ""},
			{http.MethodGet, ch + "/changes", ""},
		}},
		{"positions", 120, []route{
			{http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "", time.Now()))},
			{http.MethodPost, ch + "/progress", `{"progression":0.5}`},
		}},
		{"state writes", 60, []route{
			{http.MethodPost, ch + "/open", `{"version_id":"` + f.ch1v1 + `"}`},
			{http.MethodPut, ch + "/done", `{"done":false}`},
			{http.MethodPost, ch + "/seen", ""},
			{http.MethodPost, "/seen", ""},
		}},
	}
	for _, g := range groups {
		for i := 0; i < g.budget; i++ {
			r := g.routes[i%len(g.routes)]
			if rr := f.do(t, r.method, r.path, r.body, f.viewer); rr.StatusCode >= 300 {
				t.Fatalf("%s: request %d %s %s: status %d", g.name, i, r.method, r.path, rr.StatusCode)
			}
		}
		for _, r := range g.routes {
			body := f.expect(t, r.method, r.path, r.body, f.viewer, http.StatusTooManyRequests)
			if got := errorCode(t, body); got != "rate_limited" {
				t.Fatalf("%s %s: error.code = %q, want rate_limited", r.method, r.path, got)
			}
		}
	}
	// A caller with no access pays from the same budget: the 404 loop is
	// limited too.
	stranger := principalHeader(fixtureStranger)
	for i := 0; i < 120; i++ {
		f.expect(t, http.MethodGet, "", "", stranger, http.StatusNotFound)
	}
	f.expect(t, http.MethodGet, "/llms.txt", "", stranger, http.StatusTooManyRequests)
}

// On a public deployment, document search leaves out documents shared with
// "anyone". Book search is already limited to the chapters the reader can
// open, and the reader can open one shared with anyone, so it finds it.
func TestBookSearchFindsChapterSharedWithAnyoneOnPublicDeployment(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", Deployment: server.DeploymentPublic, BooksEnabled: true})
	owner := principalHeader(fixtureOwner)
	folderID := createFolder(t, e, `{"title":"Fruit"}`, owner)
	ch1, _ := e.createDocument("01 · Orchard", "<html><body><p>One kumquat grows here.</p></body></html>", fixtureOwner)
	ch2, _ := e.createDocument("02 · Market", "<html><body><p>A kumquat is sold here.</p></body></html>", fixtureOwner)
	bkMoveIn(t, e, folderID, ch1, owner)
	bkMoveIn(t, e, folderID, ch2, owner)
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/book", `{}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusCreated)
	bookID := bkString(t, rr.Body.Bytes(), "book_id")
	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+ch1+"/grants", `{"principal":{"type":"anyone"},"role":"viewer"}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusCreated)

	stranger := bkHeaders(principalHeader(fixtureStranger))
	rr = do(t, e.h, http.MethodGet, "/v1/books/"+bookID, "", stranger)
	assertStatus(t, rr, http.StatusOK)
	if n := bkLen(t, rr.Body.Bytes(), "readingOrder"); n != 1 {
		t.Fatalf("readingOrder has %d chapters, want the one shared with anyone", n)
	}
	for _, q := range []string{"q=kumquat", "q=kumquat&document_id=" + ch1} {
		rr = do(t, e.h, http.MethodGet, "/v1/books/"+bookID+"/search?"+q, "", stranger)
		assertStatus(t, rr, http.StatusOK)
		if n := bkLen(t, rr.Body.Bytes(), "items"); n != 1 || bkString(t, rr.Body.Bytes(), "items.0.id") != ch1 {
			t.Fatalf("%s: search = %s, want only %s", q, rr.Body.String(), ch1)
		}
	}
}

// The spec's server-side counters: book page views, and position writes
// including rejected and stale ones.
func TestBookReadingCounters(t *testing.T) {
	metric := func(event string) float64 {
		return scrapeMetric(t, "slashdocs_book_events_total", map[string]string{"event": event})
	}
	views, saved, stale, rejected := metric("manifest_view"), metric("position_saved"), metric("position_stale"), metric("position_rejected")
	f := newReadingFixture(t)
	f.expect(t, http.MethodGet, "", "", f.viewer, http.StatusOK)
	now := time.Now()
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "", now)), f.viewer, http.StatusNoContent)
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "", now.Add(-time.Minute))), f.viewer, http.StatusNoContent)
	bad := position(f.ch1, f.ch1v1, "", now)
	bad["device_id"] = "x"
	f.expect(t, http.MethodPut, "/position", positionBody(t, bad), f.viewer, http.StatusBadRequest)
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch2v1, "", now)), f.viewer, http.StatusBadRequest)
	f.expect(t, http.MethodPut, "/position", "{", f.viewer, http.StatusBadRequest)
	// A hidden chapter is not found, not a rejected position.
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch3, f.ch3v1, "", now)), f.viewer, http.StatusNotFound)

	for event, want := range map[string]float64{
		"manifest_view": views + 1, "position_saved": saved + 1, "position_stale": stale + 1, "position_rejected": rejected + 3,
	} {
		if got := metric(event); got != want {
			t.Fatalf("%s = %v, want %v", event, got, want)
		}
	}
}
