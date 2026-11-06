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

func TestUserGrantsUseStoredProfile(t *testing.T) {
	for _, resource := range []string{"documents", "folders"} {
		t.Run(resource, func(t *testing.T) {
			for _, tc := range []struct {
				name      string
				principal string
				status    int
			}{
				{"forged profile", fmt.Sprintf(`{"type":"user","id":%q,"email":"forged@example.com","name":"Forged"}`, fixtureUser.ID), http.StatusCreated},
				{"email collision", fmt.Sprintf(`{"type":"user","id":%q,"email":%q,"name":"Forged"}`, fixtureUser.ID, fixtureOwner.Email), http.StatusCreated},
				{"id only", fmt.Sprintf(`{"type":"user","id":%q}`, fixtureUser.ID), http.StatusCreated},
				{"email only", fmt.Sprintf(`{"type":"user","email":%q,"name":"Forged"}`, fixtureUser.Email), http.StatusCreated},
				{"unknown id", fmt.Sprintf(`{"type":"user","id":"missing","email":%q}`, fixtureUser.Email), http.StatusNotFound},
				{"missing id and email", `{"type":"user","name":"Forged"}`, http.StatusBadRequest},
			} {
				t.Run(tc.name, func(t *testing.T) {
					e := newTestEnv(t)
					id := e.doc.ID
					if resource == "folders" {
						id = createFolder(t, e, `{"title":"Shared"}`, principalHeader(fixtureEditor))
					}
					rr := do(t, e.h, http.MethodPost, "/v1/"+resource+"/"+id+"/grants",
						`{"principal":`+tc.principal+`,"role":"viewer"}`, map[string]string{
							"Content-Type":     "application/json",
							"X-Test-Principal": principalHeader(fixtureEditor),
						})
					assertStatus(t, rr, tc.status)
					if tc.status == http.StatusCreated {
						var out struct {
							Principal auth.Principal `json:"principal"`
						}
						if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
							t.Fatal(err)
						}
						if out.Principal.Type != fixtureUser.Type || out.Principal.ID != fixtureUser.ID || out.Principal.Email != fixtureUser.Email || out.Principal.Name != fixtureUser.Name {
							t.Fatalf("principal = %+v, want %+v", out.Principal, fixtureUser)
						}
						var role repo.Role
						var err error
						if resource == "documents" {
							role, err = e.store.RoleForDocument(context.Background(), fixtureUser, id)
						} else {
							role, err = e.store.RoleForFolder(context.Background(), fixtureUser, id)
						}
						if err != nil || role != repo.RoleViewer {
							t.Fatalf("role = %q, err = %v, want viewer", role, err)
						}
					}
					for _, want := range []auth.Principal{fixtureUser, fixtureEditor, fixtureOwner} {
						got, err := e.store.ResolveUser(context.Background(), want.ID)
						if err != nil || got.ID != want.ID || got.Email != want.Email || got.Name != want.Name {
							t.Fatalf("stored profile = %+v, err = %v, want %+v", got, err, want)
						}
					}
				})
			}
		})
	}
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

func TestEditorCanManageDocumentGrants(t *testing.T) {
	e := newTestEnv(t)
	as := func(p auth.Principal) map[string]string {
		return map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(p)}
	}
	grant := fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID)

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", grant, as(fixtureCommenter))
	assertStatus(t, rr, http.StatusForbidden)

	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", grant, as(fixtureEditor))
	assertStatus(t, rr, http.StatusCreated)
	grantID := jsonField(t, rr.Body.Bytes(), "id")

	rr = do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/grants/"+grantID, `{"role":"editor"}`, as(fixtureCommenter))
	assertStatus(t, rr, http.StatusForbidden)
	rr = do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/grants/"+grantID, `{"role":"editor"}`, as(fixtureEditor))
	assertStatus(t, rr, http.StatusOK)

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+grantID, "", as(fixtureCommenter))
	assertStatus(t, rr, http.StatusForbidden)
	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+grantID, "", as(fixtureEditor))
	assertStatus(t, rr, http.StatusNoContent)
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

// accessCallerRole decodes current_role from an /access response. The share
// sheet gates its controls on it (canManageSharing), so it must be present and
// describe the CALLER, not the resource owner.
func accessCallerRole(t *testing.T, body []byte) string {
	t.Helper()
	var out struct {
		CurrentRole *string `json:"current_role"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("access response is not JSON: %v; body=%s", err, body)
	}
	if out.CurrentRole == nil {
		t.Fatalf("access response missing current_role: %s", body)
	}
	return *out.CurrentRole
}

func TestDocumentAccessReportsCallerRole(t *testing.T) {
	e := newTestEnv(t)
	for _, tc := range []struct {
		principal auth.Principal
		wantRole  string
	}{
		{fixtureOwner, "owner"},
		{fixtureEditor, "editor"},
		{fixtureCommenter, "commenter"},
		{fixtureViewer, "viewer"},
	} {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/access", "", map[string]string{
			"X-Test-Principal": principalHeader(tc.principal),
		})
		assertStatus(t, rr, http.StatusOK)
		if role := accessCallerRole(t, rr.Body.Bytes()); role != tc.wantRole {
			t.Fatalf("%s: current_role=%q, want %q", tc.principal.Email, role, tc.wantRole)
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
	if role := accessCallerRole(t, rr.Body.Bytes()); role != "owner" {
		t.Fatalf("owner: current_role=%q, want owner", role)
	}

	rr = do(t, e.h, http.MethodGet, "/v1/folders/"+folderID+"/access", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, rr, http.StatusOK)
	if role := accessCallerRole(t, rr.Body.Bytes()); role != "editor" {
		t.Fatalf("editor: current_role=%q, want editor", role)
	}
}
