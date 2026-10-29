package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestFolderAccessControl(t *testing.T) {
	owner := principalHeader(fixtureOwner)
	other := principalHeader(fixtureStranger)
	otherEmail := fixtureStranger.Email
	thirdEmail := fixtureAttacker.Email

	t.Run("path browsing forbidden without viewer access", func(t *testing.T) {
		e := newTestEnv(t)
		rr := do(t, e.h, http.MethodPost, "/v1/folders", `{"title":"Secret"}`, map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		rr = do(t, e.h, http.MethodGet, "/v1/folders?path=/Secret", "", map[string]string{"X-Test-Principal": other})
		if rr.Code != http.StatusForbidden && rr.Code != http.StatusNotFound {
			t.Fatalf("expected 403 or 404, got %d: %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("folder_id browsing forbidden without viewer access", func(t *testing.T) {
		e := newTestEnv(t)
		folderID := createFolder(t, e, `{"title":"Private"}`, owner)

		rr := do(t, e.h, http.MethodGet, "/v1/folders?folder_id="+folderID, "", map[string]string{"X-Test-Principal": other})
		assertStatus(t, rr, http.StatusForbidden)
	})

	t.Run("moving doc to folder requires editor on the document", func(t *testing.T) {
		e := newTestEnv(t)

		// Other creates a folder; owner creates a doc and grants other viewer.
		folderID := createFolder(t, e, `{"title":"Private"}`, other)
		docID, _ := e.createDocument("MyDoc", "<p>hi</p>", fixtureOwner)

		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants",
			`{"address":"`+otherEmail+`","role":"viewer"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		// Other (owner of folder, viewer on doc) tries to add doc — forbidden.
		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents",
			`{"document_id":"`+docID+`"}`,
			map[string]string{"X-Test-Principal": other, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusForbidden)
	})

	t.Run("moving doc to folder with editor access succeeds", func(t *testing.T) {
		e := newTestEnv(t)

		folderID := createFolder(t, e, `{"title":"MyFolder"}`, other)
		docID, _ := e.createDocument("MyDoc", "<p>hi</p>", fixtureOwner)

		rr := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants",
			`{"address":"`+otherEmail+`","role":"editor"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		// Other (owner of folder, editor on doc) adds doc — succeeds.
		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents",
			`{"document_id":"`+docID+`"}`,
			map[string]string{"X-Test-Principal": other, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusOK)
	})

	t.Run("editor can manage folder grants", func(t *testing.T) {
		e := newTestEnv(t)
		folderID := createFolder(t, e, `{"title":"Shared"}`, owner)

		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
			`{"address":"`+otherEmail+`","role":"editor"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
			`{"address":"`+thirdEmail+`","role":"viewer"}`,
			map[string]string{"X-Test-Principal": other, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)
		grantID := jsonField(t, rr.Body.Bytes(), "id")

		rr = do(t, e.h, http.MethodPatch, "/v1/folders/"+folderID+"/grants/"+grantID,
			`{"role":"editor"}`,
			map[string]string{"X-Test-Principal": other, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusOK)

		rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+folderID+"/grants/"+grantID, "", map[string]string{"X-Test-Principal": other})
		assertStatus(t, rr, http.StatusNoContent)
	})

	t.Run("commenter cannot manage folder grants", func(t *testing.T) {
		e := newTestEnv(t)
		folderID := createFolder(t, e, `{"title":"Shared"}`, owner)

		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
			`{"address":"`+otherEmail+`","role":"commenter"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
			`{"address":"`+thirdEmail+`","role":"viewer"}`,
			map[string]string{"X-Test-Principal": other, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusForbidden)
	})

	t.Run("delete non-existent folder returns 404", func(t *testing.T) {
		e := newTestEnv(t)
		rr := do(t, e.h, http.MethodDelete, "/v1/folders/fld_nonexistent", "", map[string]string{"X-Test-Principal": owner})
		if rr.Code != http.StatusForbidden && rr.Code != http.StatusNotFound {
			t.Fatalf("expected 403 or 404, got %d: %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("delete folder requires owner on target", func(t *testing.T) {
		e := newTestEnv(t)
		folderID := createFolder(t, e, `{"title":"Owned"}`, owner)

		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
			`{"address":"`+otherEmail+`","role":"editor"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+folderID, "", map[string]string{"X-Test-Principal": other})
		assertStatus(t, rr, http.StatusForbidden)
	})

	t.Run("delete folder deletes descendant folders and moves documents to root", func(t *testing.T) {
		e := newTestEnv(t)
		rootID := createFolder(t, e, `{"title":"Root"}`, owner)

		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+rootID+"/grants",
			`{"address":"`+otherEmail+`","role":"editor"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		childID := createFolder(t, e, `{"title":"Child","parent_folder_id":"`+rootID+`"}`, owner)
		docID, _ := e.createDocument("KeptDoc", "<p>kept</p>", fixtureOwner)

		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+childID+"/documents",
			`{"document_id":"`+docID+`"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusOK)

		rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+rootID, "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, rr, http.StatusNoContent)

		rr = do(t, e.h, http.MethodGet, "/v1/folders/"+childID, "", map[string]string{"X-Test-Principal": owner})
		if rr.Code != http.StatusForbidden && rr.Code != http.StatusNotFound {
			t.Fatalf("expected deleted child folder to be gone, got %d: %s", rr.Code, rr.Body.String())
		}
		rr = do(t, e.h, http.MethodGet, "/v1/documents/"+docID, "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, rr, http.StatusOK)
	})

	t.Run("move folder requires editor on destination", func(t *testing.T) {
		e := newTestEnv(t)

		// Owner creates a destination folder, grants other viewer only.
		destID := createFolder(t, e, `{"title":"Dest"}`, owner)
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+destID+"/grants",
			`{"address":"`+otherEmail+`","role":"viewer"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		// Other creates their own folder and tries to move it into Dest.
		srcID := createFolder(t, e, `{"title":"Source"}`, other)
		rr = do(t, e.h, http.MethodPatch, "/v1/folders/"+srcID,
			`{"parent_folder_id":"`+destID+`"}`,
			map[string]string{"X-Test-Principal": other, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusForbidden)
	})

	t.Run("moving doc out of a folder requires editor on that folder unless owner", func(t *testing.T) {
		e := newTestEnv(t)

		// Owner files a doc in Shared and gives other editor on the doc only.
		sharedID := createFolder(t, e, `{"title":"Shared"}`, owner)
		docID, _ := e.createDocument("MyDoc", "<p>hi</p>", fixtureOwner)
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+sharedID+"/documents",
			`{"document_id":"`+docID+`"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusOK)
		rr = do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants",
			`{"address":"`+otherEmail+`","role":"editor"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		// Other cannot pull the doc out of Shared into a private folder.
		privateID := createFolder(t, e, `{"title":"Private"}`, other)
		move := func() int {
			return do(t, e.h, http.MethodPost, "/v1/folders/"+privateID+"/documents",
				`{"document_id":"`+docID+`"}`,
				map[string]string{"X-Test-Principal": other, "Content-Type": "application/json"}).Code
		}
		if code := move(); code != http.StatusForbidden {
			t.Fatalf("move without editor on source = %d, want 403", code)
		}

		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+sharedID+"/grants",
			`{"address":"`+otherEmail+`","role":"editor"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)
		if code := move(); code != http.StatusOK {
			t.Fatalf("move with editor on source = %d, want 200", code)
		}

		// The owner has no role on Private, but can still take the doc back.
		rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+privateID+"/documents/"+docID, "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, rr, http.StatusNoContent)
		rr = do(t, e.h, http.MethodGet, "/v1/documents/"+docID, "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, rr, http.StatusOK)
		var doc struct {
			ParentFolderID string `json:"parent_folder_id"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &doc); err != nil || doc.ParentFolderID != "" {
			t.Fatalf("doc parent = %q err=%v, want root", doc.ParentFolderID, err)
		}
	})

	t.Run("ambiguous root path returns 409 with candidates", func(t *testing.T) {
		e := newTestEnv(t)
		alice := principalHeader(fixtureUser)
		bob := principalHeader(fixtureViewer)

		// Alice creates /Projects and shares it with Bob.
		aliceFolderID := createFolder(t, e, `{"title":"Projects"}`, alice)
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+aliceFolderID+"/grants",
			`{"address":"`+fixtureViewer.Email+`","role":"viewer"}`,
			map[string]string{"X-Test-Principal": alice, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)

		// Bob creates his own /Projects.
		_ = createFolder(t, e, `{"title":"Projects"}`, bob)

		// Bob resolves /Projects — ambiguous (owns one, has a grant on another).
		rr = do(t, e.h, http.MethodGet, "/v1/folders?path=/Projects", "", map[string]string{"X-Test-Principal": bob})
		assertStatus(t, rr, http.StatusConflict)

		var resp struct {
			Error      struct{ Code string } `json:"error"`
			Candidates []struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"candidates"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Error.Code != "ambiguous_path" {
			t.Fatalf("code=%q", resp.Error.Code)
		}
		if len(resp.Candidates) != 2 {
			t.Fatalf("expected 2 candidates, got %d", len(resp.Candidates))
		}
	})
}

func TestRevokedNestedFolderWorkspaceEntryDoesNotLeakMetadata(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	viewer := principalHeader(fixtureStranger)

	rootID := createFolder(t, e, `{"title":"Private root"}`, owner)
	childID := createFolder(t, e, `{"title":"Private child","parent_folder_id":"`+rootID+`"}`, owner)

	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+childID+"/grants",
		`{"address":"`+fixtureStranger.Email+`","role":"viewer"}`,
		map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusCreated)
	grantID := jsonField(t, rr.Body.Bytes(), "id")

	// Opening a shared nested folder records it in the viewer's workspace.
	rr = do(t, e.h, http.MethodGet, "/v1/folders/"+childID, "", map[string]string{"X-Test-Principal": viewer})
	assertStatus(t, rr, http.StatusOK)
	rr = do(t, e.h, http.MethodGet, "/v1/folders", "", map[string]string{"X-Test-Principal": viewer})
	assertStatus(t, rr, http.StatusOK)
	if !folderListingContains(t, rr.Body.Bytes(), childID) {
		t.Fatalf("opened shared child %q missing from workspace: %s", childID, rr.Body.String())
	}

	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+childID+"/grants/"+grantID, "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, rr, http.StatusNoContent)

	// Revocation blocks direct access and must also remove the stale workspace
	// entry from root listing results, even if the row remains in the database.
	rr = do(t, e.h, http.MethodGet, "/v1/folders/"+childID, "", map[string]string{"X-Test-Principal": viewer})
	assertStatus(t, rr, http.StatusForbidden)
	rr = do(t, e.h, http.MethodGet, "/v1/folders", "", map[string]string{"X-Test-Principal": viewer})
	assertStatus(t, rr, http.StatusOK)
	if folderListingContains(t, rr.Body.Bytes(), childID) {
		t.Fatalf("revoked child %q leaked through workspace listing: %s", childID, rr.Body.String())
	}

	// Current access inherited from an ancestor must continue to surface the
	// opened child for both a principal-specific grant and an anyone grant.
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+rootID+"/grants",
		`{"address":"`+fixtureStranger.Email+`","role":"viewer"}`,
		map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusCreated)
	inheritedGrantID := jsonField(t, rr.Body.Bytes(), "id")
	rr = do(t, e.h, http.MethodGet, "/v1/folders", "", map[string]string{"X-Test-Principal": viewer})
	assertStatus(t, rr, http.StatusOK)
	if !folderListingContains(t, rr.Body.Bytes(), childID) {
		t.Fatalf("child %q missing with inherited principal grant: %s", childID, rr.Body.String())
	}
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+rootID+"/grants/"+inheritedGrantID, "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, rr, http.StatusNoContent)

	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+rootID+"/grants",
		`{"principal":{"type":"anyone"},"role":"viewer"}`,
		map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusCreated)
	anyoneGrantID := jsonField(t, rr.Body.Bytes(), "id")
	rr = do(t, e.h, http.MethodGet, "/v1/folders", "", map[string]string{"X-Test-Principal": viewer})
	assertStatus(t, rr, http.StatusOK)
	if !folderListingContains(t, rr.Body.Bytes(), childID) {
		t.Fatalf("child %q missing with inherited anyone grant: %s", childID, rr.Body.String())
	}
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+rootID+"/grants/"+anyoneGrantID, "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, rr, http.StatusNoContent)
}

func folderListingContains(t *testing.T, body []byte, folderID string) bool {
	t.Helper()
	var response struct {
		Items []struct {
			Type   string `json:"type"`
			Folder *struct {
				ID string `json:"id"`
			} `json:"folder"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode folder listing: %v", err)
	}
	for _, item := range response.Items {
		if item.Type == "folder" && item.Folder != nil && item.Folder.ID == folderID {
			return true
		}
	}
	return false
}

// createFolder creates a folder as the given principal header and returns its id.
func createFolder(t *testing.T, e *testEnv, body, principal string) string {
	t.Helper()
	rr := do(t, e.h, http.MethodPost, "/v1/folders", body, map[string]string{"X-Test-Principal": principal, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusCreated)
	return jsonField(t, rr.Body.Bytes(), "id")
}

// TestFolderDocumentCallerRole verifies that GET /v1/folders/{id}/documents
// always includes a "caller_role" field on every document entry, even when the
// caller has no direct grant (RoleNone = ""). The field must not be omitted.
func TestFolderDocumentCallerRole(t *testing.T) {
	e := newTestEnv(t)
	folderOwner := principalHeader(fixtureOwner)
	docOwner := principalHeader(fixtureStranger)

	// folderOwner creates folder, docOwner files their own document into it.
	folderID := createFolder(t, e, `{"title":"MyFolder"}`, folderOwner)
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
		`{"address":"`+fixtureStranger.Email+`","role":"editor"}`,
		map[string]string{"X-Test-Principal": folderOwner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusCreated)

	docID, _ := e.createDocument("InFolder", "<p>x</p>", fixtureStranger)
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents",
		`{"document_id":"`+docID+`"}`,
		map[string]string{"X-Test-Principal": docOwner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusOK)

	// folderOwner lists the folder — they have no direct grant on docOwner's
	// document, so caller_role must be "" (not omitted).
	rr = do(t, e.h, http.MethodGet, "/v1/folders/"+folderID+"/documents", "", map[string]string{"X-Test-Principal": folderOwner})
	assertStatus(t, rr, http.StatusOK)

	// Use raw map to distinguish absent key from present empty string.
	var raw struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw: %v", err)
	}
	if len(raw.Items) == 0 {
		t.Fatalf("expected at least one document in listing, got 0; body=%s", rr.Body.String())
	}
	for i, item := range raw.Items {
		if _, present := item["caller_role"]; !present {
			t.Errorf("items[%d]: caller_role key absent (omitempty bug)", i)
		}
	}
}

// TestGetDocumentActionable403ForFolderOwner verifies that a folder owner who
// has no role on a document in their folder receives a 403 with an actionable
// message pointing to the DELETE /v1/folders/{fld}/documents/{doc} endpoint.
func TestGetDocumentActionable403ForFolderOwner(t *testing.T) {
	e := newTestEnv(t)
	folderOwner := principalHeader(fixtureStranger) // will own the folder
	docOwner := principalHeader(fixtureOwner)        // owns the doc, not the folder

	// folderOwner creates a folder; docOwner puts their document in it.
	folderID := createFolder(t, e, `{"title":"TrapFolder"}`, folderOwner)
	docID, _ := e.createDocument("TrapDoc", "<p>x</p>", fixtureOwner)

	// docOwner needs editor on the folder to move the doc in.
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
		`{"address":"`+fixtureOwner.Email+`","role":"editor"}`,
		map[string]string{"X-Test-Principal": folderOwner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusCreated)

	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents",
		`{"document_id":"`+docID+`"}`,
		map[string]string{"X-Test-Principal": docOwner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusOK)

	// folderOwner fetches the document they have no role on — expect 403 with
	// the actionable message embedding the folder and document IDs.
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+docID, "", map[string]string{"X-Test-Principal": folderOwner})
	assertStatus(t, rr, http.StatusForbidden)

	body := rr.Body.String()
	if !strings.Contains(body, folderID) {
		t.Errorf("expected 403 message to contain folder ID %q; got: %s", folderID, body)
	}
	if !strings.Contains(body, docID) {
		t.Errorf("expected 403 message to contain doc ID %q; got: %s", docID, body)
	}
	if !strings.Contains(body, "DELETE") {
		t.Errorf("expected 403 message to mention DELETE endpoint; got: %s", body)
	}
}

// TestGetDocumentGeneric403ForNonFolderOwner verifies that a caller who has
// no role on the document AND no owner role on its parent folder receives the
// generic 403 — the folder ID must not appear in the response body.
func TestGetDocumentGeneric403ForNonFolderOwner(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	attacker := principalHeader(fixtureAttacker)

	folderID := createFolder(t, e, `{"title":"Private"}`, owner)
	docID, _ := e.createDocument("Secret", "<p>x</p>", fixtureOwner)
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents",
		`{"document_id":"`+docID+`"}`,
		map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusOK)

	// Attacker knows the doc ID but has no access to the folder.
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+docID, "", map[string]string{"X-Test-Principal": attacker})
	assertStatus(t, rr, http.StatusForbidden)

	body := rr.Body.String()
	if strings.Contains(body, folderID) {
		t.Errorf("folder ID %q must not appear in 403 body for non-folder-owner; got: %s", folderID, body)
	}
}
