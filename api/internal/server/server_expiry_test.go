package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

// createWith uploads a document with more form fields.
func createWith(e *testEnv, fields map[string]string, p auth.Principal) *httptest.ResponseRecorder {
	e.t.Helper()
	body, contentType := multipartBody(e.t, fields, "file", "doc.html", "<html><body>scratch</body></html>")
	return doRaw(e.t, e.h, http.MethodPost, "/v1/documents", body, map[string]string{
		"Content-Type":     contentType,
		"X-Test-Principal": principalHeader(p),
	})
}

// patchDoc sends a JSON body to PATCH /v1/documents/{id}.
func patchDoc(e *testEnv, docID, body string, p auth.Principal) *httptest.ResponseRecorder {
	e.t.Helper()
	return do(e.t, e.h, http.MethodPatch, "/v1/documents/"+docID, body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(p),
	})
}

// document is the part of a document response that the expiry tests read.
type document struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	ExpiresAt string `json:"expires_at"`
}

func decodeDocument(t *testing.T, rr *httptest.ResponseRecorder) document {
	t.Helper()
	var d document
	if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
		t.Fatalf("the response is not a document: %v: %s", err, rr.Body)
	}
	return d
}

func getDocument(e *testEnv, docID string) document {
	e.t.Helper()
	rr := do(e.t, e.h, http.MethodGet, "/v1/documents/"+docID, "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
	assertStatus(e.t, rr, http.StatusOK)
	return decodeDocument(e.t, rr)
}

// assertExpiresIn makes sure that an expiry time is the period from now,
// within a minute.
func assertExpiresIn(t *testing.T, expiresAt string, period time.Duration) {
	t.Helper()
	at, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		t.Fatalf("the expiry %q is not an RFC 3339 time: %v", expiresAt, err)
	}
	if off := time.Until(at) - period; off < -time.Minute || off > time.Minute {
		t.Fatalf("the expiry %s is %v from now, want %v", expiresAt, time.Until(at).Round(time.Second), period)
	}
}

const day = 24 * time.Hour

func TestCreateDocumentWithAPeriodSetsTheExpiry(t *testing.T) {
	e := newTestEnv(t)
	rr := createWith(e, map[string]string{"title": "Scratch", "expires_in": "7d"}, fixtureOwner)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeDocument(t, rr)
	assertExpiresIn(t, created.ExpiresAt, 7*day)
	if got := getDocument(e, created.ID).ExpiresAt; got != created.ExpiresAt {
		t.Fatalf("GET gave the expiry %q, and the create gave %q", got, created.ExpiresAt)
	}
}

func TestCreateDocumentWithATimeSetsTheExpiry(t *testing.T) {
	e := newTestEnv(t)
	at := time.Now().Add(2 * day).UTC().Truncate(time.Second).Format(time.RFC3339)
	rr := createWith(e, map[string]string{"title": "Scratch", "expires_at": at}, fixtureOwner)
	assertStatus(t, rr, http.StatusCreated)
	if got := decodeDocument(t, rr).ExpiresAt; got != at {
		t.Fatalf("the create gave the expiry %q, want %q", got, at)
	}
}

func TestCreateDocumentWithoutAnExpiryHasNone(t *testing.T) {
	e := newTestEnv(t)
	rr := createWith(e, map[string]string{"title": "Kept"}, fixtureOwner)
	assertStatus(t, rr, http.StatusCreated)
	if strings.Contains(rr.Body.String(), "expires_at") {
		t.Fatalf("the response of a document that is kept holds expires_at: %s", rr.Body)
	}
}

// A wrong expiry makes no document: a document that the person wanted to go
// would stay for ever.
func TestCreateDocumentRefusesAWrongExpiry(t *testing.T) {
	e := newTestEnv(t)
	for name, fields := range map[string]map[string]string{
		"a bare m":           {"expires_in": "3m"},
		"no unit":            {"expires_in": "7"},
		"a time in the past": {"expires_at": "2020-01-01T00:00:00Z"},
		"a time that is not": {"expires_at": "next week"},
		"both":               {"expires_in": "7d", "expires_at": time.Now().Add(day).UTC().Format(time.RFC3339)},
	} {
		fields["title"] = "Wrong expiry"
		rr := createWith(e, fields, fixtureOwner)
		assertStatus(t, rr, http.StatusBadRequest)
		if !strings.Contains(rr.Body.String(), `"code":"bad_request"`) {
			t.Errorf("%s: the response is %s", name, rr.Body)
		}
	}
	docs, _, err := e.store.ListDocuments(context.Background(), fixtureOwner, repo.Page{Limit: 100}, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if d.Title == "Wrong expiry" {
			t.Fatal("a create with a wrong expiry made a document")
		}
	}
}

func TestPatchDocumentSetsChangesAndRemovesTheExpiry(t *testing.T) {
	e := newTestEnv(t)
	id := e.doc.ID

	rr := patchDoc(e, id, `{"expires_in":"3d"}`, fixtureOwner)
	assertStatus(t, rr, http.StatusOK)
	set := decodeDocument(t, rr)
	assertExpiresIn(t, set.ExpiresAt, 3*day)
	if set.Title != "fixture" {
		t.Fatalf("a change of the expiry gave the title %q", set.Title)
	}

	at := time.Now().Add(10 * day).UTC().Truncate(time.Second).Format(time.RFC3339)
	rr = patchDoc(e, id, `{"expires_at":"`+at+`"}`, fixtureOwner)
	assertStatus(t, rr, http.StatusOK)
	if got := decodeDocument(t, rr).ExpiresAt; got != at {
		t.Fatalf("PATCH gave the expiry %q, want %q", got, at)
	}

	// A rename keeps the expiry, as before this field was there.
	rr = patchDoc(e, id, `{"title":"Renamed"}`, fixtureOwner)
	assertStatus(t, rr, http.StatusOK)
	if got := decodeDocument(t, rr); got.Title != "Renamed" || got.ExpiresAt != at {
		t.Fatalf("a rename gave %+v, want the title Renamed and the expiry %s", got, at)
	}

	rr = patchDoc(e, id, `{"title":"Both","expires_in":"1d"}`, fixtureOwner)
	assertStatus(t, rr, http.StatusOK)
	both := decodeDocument(t, rr)
	assertExpiresIn(t, both.ExpiresAt, day)
	if both.Title != "Both" {
		t.Fatalf("PATCH gave the title %q, want Both", both.Title)
	}

	rr = patchDoc(e, id, `{"expires_at":null}`, fixtureOwner)
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), "expires_at") {
		t.Fatalf("after a null the document still has an expiry: %s", rr.Body)
	}
	if got := getDocument(e, id); got.ExpiresAt != "" || got.Title != "Both" {
		t.Fatalf("GET gave %+v, want the title Both and no expiry", got)
	}
}

func TestPatchDocumentRefusesAWrongBody(t *testing.T) {
	e := newTestEnv(t)
	at := time.Now().Add(day).UTC().Format(time.RFC3339)
	for name, body := range map[string]string{
		"nothing":               `{}`,
		"a bare m":              `{"expires_in":"3m"}`,
		"a period and a time":   `{"expires_in":"7d","expires_at":"` + at + `"}`,
		"a period and a null":   `{"expires_in":"7d","expires_at":null}`,
		"an empty time":         `{"expires_at":""}`,
		"a number for the time": `{"expires_at":5}`,
		"a time in the past":    `{"expires_at":"2020-01-01T00:00:00Z"}`,
	} {
		rr := patchDoc(e, e.doc.ID, body, fixtureOwner)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: PATCH gave %d, want 400: %s", name, rr.Code, rr.Body)
		}
	}
	if got := getDocument(e, e.doc.ID); got.ExpiresAt != "" {
		t.Fatalf("a wrong body gave the document the expiry %q", got.ExpiresAt)
	}
}

// The handler checks all fields before it writes one.
func TestAPatchWithAWrongExpiryKeepsTheTitle(t *testing.T) {
	e := newTestEnv(t)
	assertStatus(t, patchDoc(e, e.doc.ID, `{"title":"New title","expires_in":"3m"}`, fixtureOwner), http.StatusBadRequest)
	if got := getDocument(e, e.doc.ID).Title; got != "fixture" {
		t.Fatalf("the title is %q after a PATCH that was refused", got)
	}
}

// An expiry is a delete at a later time, so it needs the role that a delete
// needs.
func TestOnlyTheOwnerChangesTheExpiry(t *testing.T) {
	e := newTestEnv(t)
	for _, p := range []auth.Principal{fixtureEditor, fixtureCommenter, fixtureViewer, fixtureStranger} {
		rr := patchDoc(e, e.doc.ID, `{"expires_in":"1d"}`, p)
		if rr.Code != http.StatusForbidden {
			t.Errorf("%s set the expiry: %d %s", p.Name, rr.Code, rr.Body)
		}
	}
	if got := getDocument(e, e.doc.ID).ExpiresAt; got != "" {
		t.Fatalf("a principal who is not the owner gave the document the expiry %q", got)
	}
	assertStatus(t, patchDoc(e, e.doc.ID, `{"expires_in":"1d"}`, fixtureOwner), http.StatusOK)
	for _, p := range []auth.Principal{fixtureEditor, fixtureStranger} {
		if rr := patchDoc(e, e.doc.ID, `{"expires_at":null}`, p); rr.Code != http.StatusForbidden {
			t.Errorf("%s removed the expiry: %d %s", p.Name, rr.Code, rr.Body)
		}
	}
	if got := getDocument(e, e.doc.ID).ExpiresAt; got == "" {
		t.Fatal("a principal who is not the owner removed the expiry")
	}
}

// ownerOfAll says that the caller owns every document, as the role check
// says a moment before the sweep deletes the document.
type ownerOfAll struct{ repo.Repository }

func (ownerOfAll) RoleForDocument(context.Context, auth.Principal, string) (repo.Role, error) {
	return repo.RoleOwner, nil
}

func TestAPatchOfADocumentThatWentAwayIsNotFound(t *testing.T) {
	e := newTestEnv(t)
	h := server.New(server.Config{Environment: "test"}, server.WithRepository(ownerOfAll{e.store}), server.WithAuthenticator(testPrincipalAuth{})).Handler()
	for _, body := range []string{`{"expires_in":"1d"}`, `{"title":"Gone"}`} {
		rr := do(t, h, http.MethodPatch, "/v1/documents/doc_gone", body, map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureOwner),
		})
		assertStatus(t, rr, http.StatusNotFound)
	}
}

func TestDocumentListsCarryTheExpiry(t *testing.T) {
	e := newTestEnv(t)
	rr := createWith(e, map[string]string{"title": "Temporary plan", "expires_in": "7d"}, fixtureOwner)
	assertStatus(t, rr, http.StatusCreated)
	want := decodeDocument(t, rr)
	assertExpiresIn(t, want.ExpiresAt, 7*day)
	for _, path := range []string{"/v1/documents", "/v1/documents?q=temporary"} {
		rr := do(t, e.h, http.MethodGet, path, "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
		assertStatus(t, rr, http.StatusOK)
		var list struct {
			Items []document `json:"items"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, d := range list.Items {
			switch {
			case d.ID == want.ID && d.ExpiresAt == want.ExpiresAt:
				found = true
			case d.ID == want.ID:
				t.Errorf("%s gave the expiry %q, want %q", path, d.ExpiresAt, want.ExpiresAt)
			case d.ExpiresAt != "":
				t.Errorf("%s gave the document %s, which is kept, the expiry %q", path, d.ID, d.ExpiresAt)
			}
		}
		if !found {
			t.Errorf("%s does not list the document with its expiry: %s", path, rr.Body)
		}
	}
}

// A page that shows the document learns of the change, as it does of a
// rename.
func TestAChangeOfTheExpiryTellsTheOpenPages(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	before, err := e.store.CurrentDocumentKVRevision(ctx, e.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, patchDoc(e, e.doc.ID, `{"expires_in":"1d"}`, fixtureOwner), http.StatusOK)
	events, err := e.store.ListDocumentKVEvents(ctx, e.doc.ID, before, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Kind != repo.DocumentEventDocument {
		t.Fatalf("the change of the expiry stored the events %+v, want one document event", events)
	}
}

func TestTheExpiryIsCounted(t *testing.T) {
	e := newTestEnv(t)
	labels := func(event string) map[string]string { return map[string]string{"event": event, "actor_type": "user"} }
	set, removed := scrapeMetric(t, "slashdocs_document_events_total", labels("expiry_set")), scrapeMetric(t, "slashdocs_document_events_total", labels("expiry_removed"))
	assertStatus(t, createWith(e, map[string]string{"title": "Counted", "expires_in": "1d"}, fixtureOwner), http.StatusCreated)
	assertStatus(t, patchDoc(e, e.doc.ID, `{"expires_in":"1d"}`, fixtureOwner), http.StatusOK)
	assertStatus(t, patchDoc(e, e.doc.ID, `{"expires_at":null}`, fixtureOwner), http.StatusOK)
	// A rename is no change of the expiry.
	assertStatus(t, patchDoc(e, e.doc.ID, `{"title":"Renamed"}`, fixtureOwner), http.StatusOK)
	if got := scrapeMetric(t, "slashdocs_document_events_total", labels("expiry_set")) - set; got != 2 {
		t.Fatalf("expiry_set went up by %v, want 2", got)
	}
	if got := scrapeMetric(t, "slashdocs_document_events_total", labels("expiry_removed")) - removed; got != 1 {
		t.Fatalf("expiry_removed went up by %v, want 1", got)
	}
}

func configOf(t *testing.T, e *testEnv) map[string]any {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/config", "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
	assertStatus(t, rr, http.StatusOK)
	var config map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func TestTheConfigTellsThatExpiryIsOn(t *testing.T) {
	if got := configOf(t, newTestEnv(t))["document_expiry_enabled"]; got != true {
		t.Fatalf("document_expiry_enabled = %v, want true", got)
	}
}

// An operator turns the sweep off, and then no document is deleted. A new
// expiry would be a promise that the server does not keep, so it is refused.
// A person can still remove an expiry.
func TestANewExpiryIsRefusedWhenTheFeatureIsOff(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", DisableDocumentExpiry: true})
	if got := configOf(t, e)["document_expiry_enabled"]; got != false {
		t.Fatalf("document_expiry_enabled = %v, want false", got)
	}
	const refused = `{"error":{"code":"feature_disabled","message":"Document expiry is turned off on this server"}}`
	rr := createWith(e, map[string]string{"title": "Off", "expires_in": "1d"}, fixtureOwner)
	assertStatus(t, rr, http.StatusNotFound)
	assertJSON(t, rr.Body.Bytes(), refused)
	rr = patchDoc(e, e.doc.ID, `{"expires_in":"1d"}`, fixtureOwner)
	assertStatus(t, rr, http.StatusNotFound)
	assertJSON(t, rr.Body.Bytes(), refused)

	// A document can have an expiry from the time before the feature was off.
	week := time.Now().Add(7 * day)
	if _, err := e.store.ChangeDocument(context.Background(), e.doc.ID, repo.DocumentChange{ExpiresAt: &week}); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, patchDoc(e, e.doc.ID, `{"expires_at":null}`, fixtureOwner), http.StatusOK)
	assertStatus(t, createWith(e, map[string]string{"title": "Kept"}, fixtureOwner), http.StatusCreated)
	assertStatus(t, patchDoc(e, e.doc.ID, `{"title":"Renamed"}`, fixtureOwner), http.StatusOK)
}
