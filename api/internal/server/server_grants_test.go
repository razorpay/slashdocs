package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestGrantDocumentAccessToServiceAccount(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "editor"
	}`, e.sa.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusCreated)
	grantID := jsonField(t, rr.Body.Bytes(), "id")
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "id": %q,
	  "resource": { "type": "document", "id": %q },
	  "principal": { "type": "service_account", "id": %q },
	  "role": "editor",
	  "granted_by": { "id": "owner_1", "email": "owner@example.com" }
	}`, grantID, e.doc.ID, e.sa.ID))
}

func TestGrantDocumentAccessToUserByEmail(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "user", "email": "owner@example.com" },
	  "role": "commenter"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusCreated)
	grantID := jsonField(t, rr.Body.Bytes(), "id")
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "id": %q,
	  "resource": { "type": "document", "id": %q },
	  "principal": { "type": "user", "id": "owner_1", "email": "owner@example.com", "name": "Owner" },
	  "role": "commenter",
	  "granted_by": { "id": "owner_1", "email": "owner@example.com" }
	}`, grantID, e.doc.ID))
}

func TestGrantDocumentAccessRejectsUnknownUserEmail(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "user", "email": "reviewer@nowhere.example" },
	  "role": "commenter"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "No slashdocs user exists") {
		t.Fatalf("response = %s", rr.Body.String())
	}
}

func TestPatchGrantRejectsOwnerRole(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusCreated)
	grantID := jsonField(t, rr.Body.Bytes(), "id")

	rr = do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/grants/"+grantID, `{"role":"owner"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusBadRequest)
}

// seedDocumentGrant creates (or resurrects) a grant on the fixture document and
// returns it, so a test can address one specific grant by id.
func seedDocumentGrant(t *testing.T, e *testEnv, p auth.Principal, role repo.Role) repo.Grant {
	t.Helper()
	g, err := e.store.CreateGrant(context.Background(), "document", e.doc.ID, p, role, fixtureOwner)
	if err != nil {
		t.Fatalf("seed document grant: %v", err)
	}
	return g
}

// Agents publish most documents here, so a bot-created document must stay
// shareable by a human. documents.owner_id holds the service account, and
// RoleForDocument compares the caller against it directly, so no user is ever
// the canonical owner of a bot-created document.
func TestServiceAccountOwnedDocumentIsShareableByItsHumanOwner(t *testing.T) {
	e := newTestEnv(t)
	bot := auth.Principal{Type: auth.PrincipalServiceAccount, ID: e.sa.ID}
	docID, _ := e.createDocument("bot report", "<html><body>hi</body></html>", bot)

	// fixtureOwner owns the service account that owns this document.
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants", `{
	  "principal": { "type": "user", "email": "viewer@example.com" },
	  "role": "viewer"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusCreated)
}

// Managing sharing is owner-only. This replaces the previous policy, under
// which any commenter could create, change, and revoke grants.
func TestCommenterCannotManageDocumentGrants(t *testing.T) {
	e := newTestEnv(t)
	commenter := map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	}
	viewerGrant := seedDocumentGrant(t, e, fixtureViewer, repo.RoleViewer)

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID), commenter)
	assertStatus(t, rr, http.StatusForbidden)

	rr = do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/grants/"+viewerGrant.ID, `{"role":"editor"}`, commenter)
	assertStatus(t, rr, http.StatusForbidden)

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+viewerGrant.ID, "", commenter)
	assertStatus(t, rr, http.StatusForbidden)
}

// The escalation this policy exists to stop: a commenter minting themselves a
// higher role through the grant API.
func TestCommenterCannotGrantThemselvesEditor(t *testing.T) {
	e := newTestEnv(t)

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "user", "id": %q },
	  "role": "editor"
	}`, fixtureCommenter.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusForbidden)

	// The commenter must still be a commenter.
	role, err := e.store.RoleForDocument(context.Background(), fixtureCommenter, e.doc.ID)
	if err != nil {
		t.Fatalf("role lookup: %v", err)
	}
	if role != repo.RoleCommenter {
		t.Fatalf("role after refused self-grant = %q, want %q", role, repo.RoleCommenter)
	}
}

// Editors write document content; they do not decide who else gets in.
func TestEditorCannotManageDocumentGrants(t *testing.T) {
	e := newTestEnv(t)

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, rr, http.StatusForbidden)
}

// The general-access grant belongs to everyone, not to whoever happens to be
// reading. A non-owner must not be able to revoke it and strip access from
// every other principal who reaches the document through it.
func TestNonOwnerCannotRemoveGeneralAccessGrant(t *testing.T) {
	e := newTestEnv(t)
	anyoneGrant := seedDocumentGrant(t, e, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleCommenter)

	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+anyoneGrant.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusForbidden)

	// A principal whose only access is the general-access grant still has it.
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	assertStatus(t, rr, http.StatusOK)
}

// Leaving a document is the one grant operation a non-owner may perform. The
// actor is a viewer, who holds no grant-management role at all: that is what
// makes this a test of the self-removal exception rather than of some wider
// revoke permission the caller happens to have.
func TestPrincipalCanRemoveOwnDocumentGrant(t *testing.T) {
	e := newTestEnv(t)
	ownGrant := seedDocumentGrant(t, e, fixtureViewer, repo.RoleViewer)

	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+ownGrant.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusNoContent)

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusForbidden)
}

// Self-removal is scoped to your own grant: it is not a general revoke verb.
func TestPrincipalCannotRemoveAnotherPrincipalsGrant(t *testing.T) {
	e := newTestEnv(t)
	viewerGrant := seedDocumentGrant(t, e, fixtureViewer, repo.RoleViewer)

	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+viewerGrant.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusForbidden)

	role, err := e.store.RoleForDocument(context.Background(), fixtureViewer, e.doc.ID)
	if err != nil {
		t.Fatalf("role lookup: %v", err)
	}
	if role != repo.RoleViewer {
		t.Fatalf("viewer role after refused revoke = %q, want %q", role, repo.RoleViewer)
	}
}

// TestGrantReAddAfterRevokeReturnsPersistedID locks in that re-granting a
// previously revoked (resource, principal) pair returns the id of the
// resurrected row: the id handed back by create must round-trip through
// revoke, or every add->revoke->add sequence strands an unusable id.
func TestGrantReAddAfterRevokeReturnsPersistedID(t *testing.T) {
	e := newTestEnv(t)
	owner := map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	}
	body := fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID)

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", body, owner)
	assertStatus(t, rr, http.StatusCreated)
	firstID := jsonField(t, rr.Body.Bytes(), "id")

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+firstID, "", owner)
	assertStatus(t, rr, http.StatusNoContent)

	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", body, owner)
	assertStatus(t, rr, http.StatusCreated)
	secondID := jsonField(t, rr.Body.Bytes(), "id")
	if secondID != firstID {
		t.Fatalf("re-add returned id %q, want resurrected grant %q", secondID, firstID)
	}

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+secondID, "", owner)
	assertStatus(t, rr, http.StatusNoContent)
}

func TestViewerCannotManageDocumentGrants(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureViewer),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestGrantRejectsNonexistentServiceAccount(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "service_account", "id": "sa_missing" },
	  "role": "viewer"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusNotFound)
}

func TestGrantPatchIsScopedToDocument(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusCreated)
	grantID := jsonField(t, rr.Body.Bytes(), "id")

	otherDocID, _ := e.createDocument("Other", "<html>other</html>", fixtureOwner)
	rr = do(t, e.h, http.MethodPatch, "/v1/documents/"+otherDocID+"/grants/"+grantID, `{"role":"editor"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusNotFound)
}

// accessCallerFields decodes the caller-describing fields of an /access
// response. The share sheet gates its controls on current_role
// (canManageSharing) and canonical_owner (owner-group changes), so both must
// be present and describe the CALLER, not the resource owner.
func accessCallerFields(t *testing.T, body []byte) (role string, canonical bool) {
	t.Helper()
	var out struct {
		CurrentRole    *string `json:"current_role"`
		CanonicalOwner *bool   `json:"canonical_owner"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("access response is not JSON: %v; body=%s", err, body)
	}
	if out.CurrentRole == nil || out.CanonicalOwner == nil {
		t.Fatalf("access response missing current_role/canonical_owner: %s", body)
	}
	return *out.CurrentRole, *out.CanonicalOwner
}

func TestDocumentAccessReportsCallerRole(t *testing.T) {
	e := newTestEnv(t)
	for _, tc := range []struct {
		principal auth.Principal
		wantRole  string
		wantOwner bool
	}{
		{fixtureOwner, "owner", true},
		{fixtureEditor, "editor", false},
		{fixtureCommenter, "commenter", false},
		{fixtureViewer, "viewer", false},
	} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/access", "", map[string]string{
			"X-Test-Principal": principalHeader(tc.principal),
		})
		assertStatus(t, rr, http.StatusOK)
		role, canonical := accessCallerFields(t, rr.Body.Bytes())
		if role != tc.wantRole || canonical != tc.wantOwner {
			t.Fatalf("%s: current_role=%q canonical_owner=%v, want %q/%v", tc.principal.Email, role, canonical, tc.wantRole, tc.wantOwner)
		}
	}
}

func TestFolderAccessReportsCallerRole(t *testing.T) {
	e := newTestEnv(t)
	owner := map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	}
	folderID := createFolder(t, e, `{"title":"Shared"}`, principalHeader(fixtureOwner))
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "user", "email": %q },
	  "role": "editor"
	}`, fixtureEditor.Email), owner)
	assertStatus(t, rr, http.StatusCreated)

	rr = do(t, e.h, http.MethodGet, "/v1/folders/"+folderID+"/access", "", owner)
	assertStatus(t, rr, http.StatusOK)
	if role, canonical := accessCallerFields(t, rr.Body.Bytes()); role != "owner" || !canonical {
		t.Fatalf("owner: current_role=%q canonical_owner=%v, want owner/true", role, canonical)
	}

	rr = do(t, e.h, http.MethodGet, "/v1/folders/"+folderID+"/access", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, rr, http.StatusOK)
	if role, canonical := accessCallerFields(t, rr.Body.Bytes()); role != "editor" || canonical {
		t.Fatalf("editor: current_role=%q canonical_owner=%v, want editor/false", role, canonical)
	}
}
