package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
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

// A role on a folder cascades to what is inside it, and so does ownership of
// the folder. A resource has one owner, so the folder owner gets editor on
// the documents and subfolders that someone else put in the folder (#199).
func TestFolderOwnerIsEditorOfContentsOthersOwn(t *testing.T) {
	e := newTestEnv(t)
	owner := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json"}
	other := map[string]string{"X-Test-Principal": principalHeader(fixtureStranger), "Content-Type": "application/json"}
	folderID := createFolder(t, e, `{"title":"Team"}`, owner["X-Test-Principal"])
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"editor"}`, owner)
	assertStatus(t, rr, http.StatusCreated)
	grantID := jsonField(t, rr.Body.Bytes(), "id")

	docID, _ := e.createDocument("Note", "<p>note</p>", fixtureStranger)
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents", `{"document_id":"`+docID+`"}`, other)
	assertStatus(t, rr, http.StatusOK)
	subID := createFolder(t, e, `{"title":"Sub","parent_folder_id":"`+folderID+`"}`, other["X-Test-Principal"])

	// Revoking the grant does not take away what the folder owner has.
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+folderID+"/grants/"+grantID, "", owner)
	assertStatus(t, rr, http.StatusNoContent)

	for _, path := range []string{"/v1/documents/" + docID + "/access", "/v1/folders/" + subID + "/access"} {
		rr = do(t, e.h, http.MethodGet, path, "", owner)
		assertStatus(t, rr, http.StatusOK)
		if got := jsonField(t, rr.Body.Bytes(), "current_role"); got != "editor" {
			t.Fatalf("GET %s: current_role = %q, want editor", path, got)
		}
		if !strings.Contains(rr.Body.String(), `"principal":{"type":"user","id":"`+fixtureOwner.ID+`"`) {
			t.Fatalf("GET %s: access report does not list the folder owner: %s", path, rr.Body.String())
		}
	}
	rr = do(t, e.h, http.MethodPatch, "/v1/documents/"+docID, `{"title":"Edited"}`, owner)
	assertStatus(t, rr, http.StatusForbidden)
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+subID, "", owner)
	assertStatus(t, rr, http.StatusForbidden)
	rr = do(t, e.h, http.MethodGet, "/v1/documents?q=note", "", owner)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), docID) {
		t.Fatalf("search does not find the document in the owner's folder: %s", rr.Body.String())
	}

	// A move warns when an owner of a folder above the destination gains
	// access, also when no grant is left.
	privateID, _ := e.createDocument("Private", "<p>private</p>", fixtureStranger)
	mineID := createFolder(t, e, `{"title":"Mine"}`, other["X-Test-Principal"])
	for dest, warns := range map[string]bool{subID: true, mineID: false} {
		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+dest+"/documents", `{"document_id":"`+privateID+`"}`, other)
		assertStatus(t, rr, http.StatusOK)
		if got := strings.Contains(rr.Body.String(), `"permission_warning"`); got != warns {
			t.Fatalf("move into %s: permission_warning = %v, want %v: %s", dest, got, warns, rr.Body.String())
		}
	}

	// The folder owner can move the document out, and then has no role on it.
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+folderID+"/documents/"+docID, "", owner)
	assertStatus(t, rr, http.StatusNoContent)
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+docID, "", owner)
	assertStatus(t, rr, http.StatusForbidden)
}

// A document or folder that does not exist is a 404 for every request, as
// GET /v1/documents/{id} always was. One that exists but is not shared with
// the caller stays a 403.
func TestMissingResourcesAreNotFound(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	folderID := createFolder(t, e, `{"title":"Shelf"}`, owner)
	docID, _ := e.createDocument("Gone", "<p>x</p>", fixtureOwner)
	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+docID, "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, rr, http.StatusNoContent)

	requests := []struct{ method, path, body string }{
		{http.MethodGet, "/v1/documents/" + docID, ""},
		{http.MethodPatch, "/v1/documents/" + docID, `{"title":"x"}`},
		{http.MethodDelete, "/v1/documents/" + docID, ""},
		{http.MethodPost, "/v1/documents/" + docID + "/grants", `{"address":"` + fixtureViewer.Email + `","role":"viewer"}`},
		{http.MethodPost, "/v1/folders/" + folderID + "/documents", `{"document_id":"` + docID + `"}`},
		{http.MethodPut, "/v1/pins/document/" + docID, ""},
		{http.MethodGet, "/v1/folders/fld_missing", ""},
		{http.MethodPatch, "/v1/folders/fld_missing", `{"title":"x"}`},
		{http.MethodDelete, "/v1/folders/fld_missing", ""},
		{http.MethodPost, "/v1/folders/fld_missing/grants", `{"address":"` + fixtureViewer.Email + `","role":"viewer"}`},
		{http.MethodPut, "/v1/pins/folder/fld_missing", ""},
	}
	for _, r := range requests {
		rr := do(t, e.h, r.method, r.path, r.body, map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		if rr.Code != http.StatusNotFound {
			t.Errorf("%s %s: status = %d, want 404; body=%s", r.method, r.path, rr.Code, rr.Body.String())
		}
	}

	stranger := map[string]string{"X-Test-Principal": principalHeader(fixtureStranger), "Content-Type": "application/json"}
	for _, path := range []string{"/v1/folders/" + folderID, "/v1/documents/" + e.doc.ID} {
		rr := do(t, e.h, http.MethodDelete, path, "", stranger)
		assertStatus(t, rr, http.StatusForbidden)
	}
}

// A folder search gives each folder its path, so folders with the same title
// differ. The contents of a folder have the time of their last change.
func TestFolderSearchPathsAndContentTimes(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	north := createFolder(t, e, `{"title":"North"}`, owner)
	south := createFolder(t, e, `{"title":"South"}`, owner)
	createFolder(t, e, `{"title":"Reports","parent_folder_id":"`+north+`"}`, owner)
	createFolder(t, e, `{"title":"Reports","parent_folder_id":"`+south+`"}`, owner)
	docID, _ := e.createDocument("Plan", "<p>x</p>", fixtureOwner)
	headers := map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"}
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+north+"/documents", `{"document_id":"`+docID+`"}`, headers)
	assertStatus(t, rr, http.StatusOK)

	type listing struct {
		Items []struct {
			Type   string `json:"type"`
			Folder *struct {
				Ancestors []struct{ Title string } `json:"ancestors"`
			} `json:"folder"`
			LastActive string `json:"last_active"`
		} `json:"items"`
	}
	list := func(path string) listing {
		rr := do(t, e.h, http.MethodGet, path, "", headers)
		assertStatus(t, rr, http.StatusOK)
		var out listing
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	var paths []string
	for _, item := range list("/v1/folders?q=Reports").Items {
		var titles []string
		for _, a := range item.Folder.Ancestors {
			titles = append(titles, a.Title)
		}
		paths = append(paths, strings.Join(titles, "/"))
	}
	if strings.Join(paths, ",") != "North,South" && strings.Join(paths, ",") != "South,North" {
		t.Fatalf("search paths = %v, want North and South", paths)
	}

	contents := list("/v1/folders?folder_id=" + north).Items
	if len(contents) != 2 {
		t.Fatalf("folder has %d entries, want 2", len(contents))
	}
	for _, item := range contents {
		if item.LastActive == "" {
			t.Errorf("%s entry has no last_active", item.Type)
		}
	}
}

// A change of a folder wakes every open stream. So each principal has a
// budget of the changes of access and of the moves of folders and
// documents.
func TestFolderAccessChangesHaveABudgetForEachPrincipal(t *testing.T) {
	e := newTestEnv(t)
	patch := func(p auth.Principal) int {
		return do(t, e.h, http.MethodPatch, "/v1/folders/fld_missing/grants/grt_missing", `{}`, map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(p)}).Code
	}
	// A request that fails counts too.
	for i := range 30 {
		if got := patch(fixtureEditor); got == http.StatusTooManyRequests {
			t.Fatalf("request %d: status = %d", i, got)
		}
	}
	if got := patch(fixtureEditor); got != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", got)
	}
	if got := do(t, e.h, http.MethodDelete, "/v1/folders/fld_missing", "", map[string]string{"X-Test-Principal": principalHeader(fixtureEditor)}).Code; got != http.StatusTooManyRequests {
		t.Fatalf("folder delete: status = %d, want 429", got)
	}
	if got := patch(fixtureOwner); got == http.StatusTooManyRequests {
		t.Fatalf("another principal: status = %d", got)
	}
}

// A folder search with min_role lists only the folders where the caller has
// that role, as the move dialog needs. Its breadcrumbs show no folder that
// the caller cannot see.
func TestFolderSearchMinRoleAndHiddenAncestors(t *testing.T) {
	e := newTestEnv(t)
	owner, other := principalHeader(fixtureOwner), principalHeader(fixtureStranger)
	grant := func(folderID, role string) {
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
			`{"address":"`+fixtureStranger.Email+`","role":"`+role+`"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)
	}
	private := createFolder(t, e, `{"title":"Private"}`, owner)
	shared := createFolder(t, e, `{"title":"Team shared","parent_folder_id":"`+private+`"}`, owner)
	grant(shared, "editor")
	readOnly := createFolder(t, e, `{"title":"Team read"}`, owner)
	grant(readOnly, "viewer")
	createFolder(t, e, `{"title":"Team sub","parent_folder_id":"`+shared+`"}`, other)

	search := func(principal, query string) map[string][]string {
		rr := do(t, e.h, http.MethodGet, "/v1/folders?"+query, "", map[string]string{"X-Test-Principal": principal})
		assertStatus(t, rr, http.StatusOK)
		var out struct {
			Items []struct {
				Folder struct {
					Title     string
					Ancestors []struct{ Title string }
				}
			}
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		paths := map[string][]string{}
		for _, item := range out.Items {
			paths[item.Folder.Title] = []string{}
			for _, a := range item.Folder.Ancestors {
				paths[item.Folder.Title] = append(paths[item.Folder.Title], a.Title)
			}
		}
		return paths
	}

	if got := search(other, "q=Team"); len(got) != 3 || len(got["Team shared"]) != 0 || strings.Join(got["Team sub"], "/") != "Team shared" {
		t.Errorf("search = %v, want three folders and no Private in a path", got)
	}
	if got := search(other, "q=Team&min_role=editor"); len(got) != 2 || got["Team read"] != nil {
		t.Errorf("editor search = %v, want Team shared and Team sub", got)
	}
	// The owner of a folder is an editor of the subfolder that another user
	// made in it, not its owner.
	if got := search(owner, "min_role=editor"); len(got) != 4 {
		t.Errorf("owner editor search = %v, want all four folders", got)
	}
	if got := search(owner, "min_role=owner"); got["Team sub"] != nil || len(got) != 3 {
		t.Errorf("owner search = %v, want the three folders of the owner", got)
	}
	rr := do(t, e.h, http.MethodGet, "/v1/folders?min_role=admin", "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, rr, http.StatusBadRequest)

	// A grant to anyone counts for the role, as it does for access. But this
	// deployment is public, so a folder that only anyone can open is not
	// listed.
	anyone := func(folderID string) {
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants", `{"principal":{"type":"anyone"},"role":"editor"}`,
			map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)
	}
	anyone(readOnly)
	anyone(createFolder(t, e, `{"title":"Team open"}`, owner))
	if got := search(other, "q=Team&min_role=editor"); len(got) != 3 || got["Team read"] == nil {
		t.Errorf("editor search with anyone grants = %v, want Team read and no Team open", got)
	}
}

// GET /v1/documents/{id} says if the caller can move the document: an editor
// of the document also needs editor on its folder, and the owner does not.
func TestGetDocumentCanMove(t *testing.T) {
	e := newTestEnv(t)
	owner := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json"}
	other := map[string]string{"X-Test-Principal": principalHeader(fixtureStranger)}
	folderID := createFolder(t, e, `{"title":"Kept"}`, owner["X-Test-Principal"])
	docID, _ := e.createDocument("Movable", "<p>x</p>", fixtureOwner)
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"editor"}`, owner), http.StatusCreated)
	canMove := func(headers map[string]string) bool {
		rr := do(t, e.h, http.MethodGet, "/v1/documents/"+docID, "", headers)
		assertStatus(t, rr, http.StatusOK)
		return strings.Contains(rr.Body.String(), `"can_move":true`)
	}
	if !canMove(other) {
		t.Error("an editor of a top-level document cannot move it")
	}
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents", `{"document_id":"`+docID+`"}`, owner), http.StatusOK)
	if canMove(other) || !canMove(owner) {
		t.Errorf("can_move = %v for the editor and %v for the owner, want false and true", canMove(other), canMove(owner))
	}
}

// A document search does not show the folder of a result when the caller
// cannot see that folder.
func TestDocumentSearchHidesUnseenParentFolder(t *testing.T) {
	e := newTestEnv(t)
	owner := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json"}
	folderID := createFolder(t, e, `{"title":"Secret folder"}`, owner["X-Test-Principal"])
	docID, _ := e.createDocument("Quarterly zebra", "<p>x</p>", fixtureOwner)
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents", `{"document_id":"`+docID+`"}`, owner), http.StatusOK)
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"viewer"}`, owner), http.StatusCreated)

	search := func(headers map[string]string) string {
		rr := do(t, e.h, http.MethodGet, "/v1/documents?q=zebra", "", headers)
		assertStatus(t, rr, http.StatusOK)
		return rr.Body.String()
	}
	if body := search(map[string]string{"X-Test-Principal": principalHeader(fixtureStranger)}); !strings.Contains(body, docID) || strings.Contains(body, "Secret folder") {
		t.Errorf("stranger search = %s, want the document without its folder", body)
	}
	if body := search(owner); !strings.Contains(body, "Secret folder") {
		t.Errorf("owner search = %s, want the folder", body)
	}
}
