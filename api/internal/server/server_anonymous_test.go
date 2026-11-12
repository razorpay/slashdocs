package server_test

import (
	"net/http"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/server"
)

// shareWithAnyone gives the "anyone" principal a role on the fixture document.
func (e *testEnv) shareWithAnyone(role string) {
	e.t.Helper()
	rr := do(e.t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants",
		`{"principal":{"type":"anyone"},"role":"`+role+`"}`, map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureOwner),
		})
	assertStatus(e.t, rr, http.StatusCreated)
}

func TestAnonymousReaderReadsDocumentSharedWithAnyone(t *testing.T) {
	e := newTestEnv(t)
	e.shareWithAnyone("editor")
	doc := "/v1/documents/" + e.doc.ID
	for _, read := range []struct{ method, path string }{
		{http.MethodGet, doc},
		{http.MethodGet, doc + "/versions"},
		{http.MethodGet, doc + "/versions/" + e.ver.ID},
		{http.MethodGet, doc + "/versions/" + e.ver.ID + "/html"},
		{http.MethodPost, doc + "/versions/" + e.ver.ID + "/render-token"},
		{http.MethodPost, doc + "/versions/" + e.ver.ID + "/print-token"},
		{http.MethodGet, doc + "/comments"},
		{http.MethodGet, doc + "/kv"},
	} {
		t.Run(read.method+" "+read.path, func(t *testing.T) {
			assertStatus(t, do(t, e.h, read.method, read.path, "", nil), http.StatusOK)
		})
	}
}

// An anonymous reader must sign in to comment or edit, even on a document
// that anyone can edit.
func TestAnonymousReaderMustSignInToWrite(t *testing.T) {
	e := newTestEnv(t)
	e.shareWithAnyone("editor")
	doc := "/v1/documents/" + e.doc.ID
	for _, write := range []struct{ method, path, body string }{
		{http.MethodPost, doc + "/comments", `{"body":"hi","version_id":"` + e.ver.ID + `","anchor":{"quote":"fixture"}}`},
		{http.MethodPost, doc + "/comments/" + e.cmt.ID + "/replies", `{"body":"hi"}`},
		{http.MethodPatch, doc + "/comments/" + e.cmt.ID, `{"status":"resolved"}`},
		{http.MethodPatch, doc + "/kv", `{"set":{"k":1}}`},
		{http.MethodPost, doc + "/presence", `{"session":"s"}`},
	} {
		t.Run(write.method+" "+write.path, func(t *testing.T) {
			rr := do(t, e.h, write.method, write.path, write.body, map[string]string{"Content-Type": "application/json"})
			assertStatus(t, rr, http.StatusUnauthorized)
		})
	}
}

// A document that is not shared with anyone asks the reader to sign in,
// because the signed-in reader can have a grant.
func TestAnonymousReaderOfUnsharedDocumentMustSignIn(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", nil)
	assertStatus(t, rr, http.StatusUnauthorized)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "unauthorized", "message": "authentication required" }
	}`)

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/versions/"+e.ver.ID+"/html", "", map[string]string{"Accept": "text/html"})
	assertStatus(t, rr, http.StatusFound)
}

// On an org deployment, "anyone" means anyone in the org, so every reader
// must sign in.
func TestOrgDeploymentHasNoAnonymousReaders(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", Deployment: server.DeploymentOrg, OrgName: "Acme"})
	e.shareWithAnyone("viewer")
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", nil)
	assertStatus(t, rr, http.StatusUnauthorized)
}

func TestInvalidBearerTokenDoesNotReadAsAnonymous(t *testing.T) {
	e := newTestEnv(t)
	e.shareWithAnyone("viewer")
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", map[string]string{"Authorization": "Bearer expired"})
	assertStatus(t, rr, http.StatusUnauthorized)
}

// A document an anonymous reader opened does not join a workspace.
func TestAnonymousReaderDoesNotRecordOpen(t *testing.T) {
	e := newTestEnv(t)
	e.shareWithAnyone("viewer")
	assertStatus(t, do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", nil), http.StatusOK)
	var opened int
	if err := e.store.Pool().QueryRow(t.Context(), `SELECT count(*) FROM document_workspace_entries`).Scan(&opened); err != nil {
		t.Fatal(err)
	}
	if opened != 0 {
		t.Fatalf("workspace entries = %d, want 0", opened)
	}
}
