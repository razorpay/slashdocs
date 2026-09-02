package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/razorpay/aidocs/api/internal/auth"
	"github.com/razorpay/aidocs/api/internal/repo"
	"github.com/razorpay/aidocs/api/internal/server"
)

func TestMoveDocumentExpectedSourceAndLegacyCompatibility(t *testing.T) {
	e := newTestEnv(t)
	destination := createFolder(t, e, `{"title":"Move destination"}`, principalHeader(fixtureOwner))

	t.Run("malformed expected source is rejected", func(t *testing.T) {
		docID, _ := e.createDocument("Malformed source", "<p>doc</p>", fixtureOwner)
		for _, body := range []string{
			`{"document_id":"` + docID + `","expected_source":null}`,
			`{"document_id":"` + docID + `","expected_source":{"kind":"folder"}}`,
			`{"document_id":"` + docID + `","expected_source":{"kind":"root","folder_id":"x"}}`,
		} {
			rr := do(t, e.h, http.MethodPost, "/v1/folders/"+destination+"/documents", body, map[string]string{
				"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
			})
			assertStatus(t, rr, http.StatusBadRequest)
		}
	})

	t.Run("mismatch is a conflict and omission remains supported", func(t *testing.T) {
		docID, _ := e.createDocument("Legacy source", "<p>doc</p>", fixtureOwner)
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+destination+"/documents", `{"document_id":"`+docID+`","expected_source":{"kind":"folder","folder_id":"wrong"}}`, map[string]string{
			"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
		})
		assertStatus(t, rr, http.StatusConflict)
		var conflict struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &conflict); err != nil {
			t.Fatal(err)
		}
		if conflict.Error.Code != "source_changed" {
			t.Fatalf("error code=%q, want source_changed", conflict.Error.Code)
		}

		// Legacy callers that omit expected_source still get source-aware
		// authorization and a normal move result.
		rr = do(t, e.h, http.MethodPost, "/v1/folders/"+destination+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
			"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
		})
		assertStatus(t, rr, http.StatusOK)
		var result struct {
			Moved bool `json:"moved"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if !result.Moved {
			t.Fatalf("legacy move returned moved=false: %s", rr.Body.String())
		}
	})
}

func TestMoveDocumentDeleteRejectsMismatchedSource(t *testing.T) {
	e := newTestEnv(t)
	source := createFolder(t, e, `{"title":"Actual source"}`, principalHeader(fixtureOwner))
	other := createFolder(t, e, `{"title":"Other source"}`, principalHeader(fixtureOwner))
	docID, _ := e.createDocument("Source conflict", "<p>doc</p>", fixtureOwner)

	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusOK)

	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+other+"/documents/"+docID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusConflict)
	if !strings.Contains(rr.Body.String(), `"source_changed"`) {
		t.Fatalf("mismatched DELETE missing source_changed: %s", rr.Body.String())
	}
	got, err := e.store.GetDocument(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ParentFolderID != source {
		t.Fatalf("mismatched DELETE changed parent to %q, want %q", got.ParentFolderID, source)
	}
}

func TestMoveDocumentSameDestinationIsNoOp(t *testing.T) {
	e := newTestEnv(t)
	folderID := createFolder(t, e, `{"title":"Stable destination"}`, principalHeader(fixtureOwner))
	docID, _ := e.createDocument("No-op move", "<p>doc</p>", fixtureOwner)

	move := func() map[string]any {
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
			"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
		})
		assertStatus(t, rr, http.StatusOK)
		var body map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	first := move()
	if first["moved"] != true {
		t.Fatalf("first move=%v", first)
	}
	before, err := e.store.GetDocument(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	second := move()
	if second["moved"] != false {
		t.Fatalf("same-destination move=%v, want moved=false", second)
	}
	after, err := e.store.GetDocument(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ParentFolderID != folderID || after.UpdatedAt != before.UpdatedAt {
		t.Fatalf("same-destination changed document: before=%+v after=%+v", before, after)
	}
}

func TestMoveDocumentDoesNotRevealDestinationExistence(t *testing.T) {
	e := newTestEnv(t)
	existingDestination := createFolder(t, e, `{"title":"Existing but private"}`, principalHeader(fixtureOwner))
	docID, _ := e.createDocument("Destination oracle", "<p>doc</p>", fixtureOwner)

	// The caller may edit the document, but has no access to either destination.
	// Both an existing private folder and a nonexistent folder must produce the
	// same generic forbidden response; checking destination existence before the
	// authorization decision would turn this endpoint into an oracle.
	if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	var firstBody string
	for _, destination := range []string{existingDestination, "fld_destination_does_not_exist"} {
		rr := do(t, e.h, http.MethodPost, "/v1/folders/"+destination+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
			"X-Test-Principal": principalHeader(fixtureStranger), "Content-Type": "application/json",
		})
		assertStatus(t, rr, http.StatusForbidden)
		if firstBody == "" {
			firstBody = rr.Body.String()
		} else if rr.Body.String() != firstBody {
			t.Fatalf("destination existence leaked: existing=%s missing=%s", firstBody, rr.Body.String())
		}
	}

	// A caller who is authorized for the document and a real destination still
	// gets the normal successful move result.
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+existingDestination+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusOK)
	var moved struct {
		Moved bool `json:"moved"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}
	if !moved.Moved {
		t.Fatalf("authorized move returned moved=false: %s", rr.Body.String())
	}

	// Document lookup remains a genuine not-found response when the caller is
	// otherwise authorized for the destination.
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+existingDestination+"/documents", `{"document_id":"doc_does_not_exist"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusNotFound)
}

func TestMoveDocumentFolderSourceRequiresSourceEditor(t *testing.T) {
	e := newTestEnv(t)
	source := createFolder(t, e, `{"title":"Source permissions"}`, principalHeader(fixtureOwner))
	destination := createFolder(t, e, `{"title":"Destination permissions"}`, principalHeader(fixtureOwner))
	docID, _ := e.createDocument("Permission matrix", "<p>doc</p>", fixtureOwner)
	stranger := principalHeader(fixtureStranger)

	// The caller is an editor on the document and destination, but only a
	// viewer on the source. A folder-to-folder move must fail closed on source.
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"editor"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusCreated)
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"viewer"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusCreated)
	sourceGrant := jsonField(t, rr.Body.Bytes(), "id")
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+destination+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"editor"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusCreated)

	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusOK)
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+destination+"/documents", `{"document_id":"`+docID+`","expected_source":{"kind":"folder","folder_id":"`+source+`"}}`, map[string]string{
		"X-Test-Principal": stranger, "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusForbidden)

	// Once source editor access is granted, the same request is authorized and
	// the destination's active grant produces the post-move warning.
	rr = do(t, e.h, http.MethodPatch, "/v1/folders/"+source+"/grants/"+sourceGrant, `{"role":"editor"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusOK)
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+destination+"/documents", `{"document_id":"`+docID+`","expected_source":{"kind":"folder","folder_id":"`+source+`"}}`, map[string]string{
		"X-Test-Principal": stranger, "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusOK)
	var moved struct {
		Moved             bool `json:"moved"`
		PermissionWarning *struct {
			Kind string `json:"kind"`
		} `json:"permission_warning"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}
	if !moved.Moved || moved.PermissionWarning == nil || moved.PermissionWarning.Kind != "may_broaden_access" {
		t.Fatalf("move result=%+v, want moved with warning", moved)
	}
}

func TestMoveDocumentToRootRequiresSourceEditorAndRejectsWrongPath(t *testing.T) {
	e := newTestEnv(t)
	source := createFolder(t, e, `{"title":"Root source"}`, principalHeader(fixtureOwner))
	other := createFolder(t, e, `{"title":"Wrong source"}`, principalHeader(fixtureOwner))
	docID, _ := e.createDocument("Root matrix", "<p>doc</p>", fixtureOwner)
	stranger := principalHeader(fixtureStranger)

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"editor"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusCreated)
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"viewer"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusCreated)
	sourceGrant := jsonField(t, rr.Body.Bytes(), "id")
	rr = do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusOK)

	// An unauthorized caller must receive the generic permission response
	// before the actual source path is disclosed. The authorized-owner
	// mismatched-path conflict is covered by TestMoveDocumentDeleteRejectsMismatchedSource.
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+other+"/documents/"+docID, "", map[string]string{"X-Test-Principal": stranger})
	assertStatus(t, rr, http.StatusForbidden)
	if strings.Contains(rr.Body.String(), `"source_changed"`) {
		t.Fatalf("unauthorized wrong DELETE path disclosed source state: %s", rr.Body.String())
	}
	// Viewer access on the actual source is insufficient even though the
	// caller has editor access on the document.
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+source+"/documents/"+docID, "", map[string]string{"X-Test-Principal": stranger})
	assertStatus(t, rr, http.StatusForbidden)

	rr = do(t, e.h, http.MethodPatch, "/v1/folders/"+source+"/grants/"+sourceGrant, `{"role":"editor"}`, map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
	})
	assertStatus(t, rr, http.StatusOK)
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+source+"/documents/"+docID, "", map[string]string{"X-Test-Principal": stranger})
	assertStatus(t, rr, http.StatusNoContent)
	got, err := e.store.GetDocument(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ParentFolderID != "" {
		t.Fatalf("root move left parent=%q", got.ParentFolderID)
	}
}

func TestMoveDocumentAccessEnvelopeAndFolderSearchContract(t *testing.T) {
	e := newTestEnv(t)
	access := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/access", "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
	assertStatus(t, access, http.StatusOK)
	var ownerEnvelope struct {
		CurrentRole string `json:"current_role"`
		Canonical   bool   `json:"canonical_owner"`
	}
	if err := json.Unmarshal(access.Body.Bytes(), &ownerEnvelope); err != nil {
		t.Fatal(err)
	}
	if ownerEnvelope.CurrentRole != "owner" || !ownerEnvelope.Canonical {
		t.Fatalf("owner envelope=%+v", ownerEnvelope)
	}
	access = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/access", "", map[string]string{"X-Test-Principal": principalHeader(fixtureViewer)})
	assertStatus(t, access, http.StatusOK)
	var viewerEnvelope struct {
		CurrentRole string `json:"current_role"`
		Canonical   bool   `json:"canonical_owner"`
	}
	if err := json.Unmarshal(access.Body.Bytes(), &viewerEnvelope); err != nil {
		t.Fatal(err)
	}
	if viewerEnvelope.CurrentRole != "viewer" || viewerEnvelope.Canonical {
		t.Fatalf("viewer envelope=%+v", viewerEnvelope)
	}

	if rr := do(t, e.h, http.MethodGet, "/v1/folders?q=anything&min_role=admin", "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)}); rr.Code != http.StatusBadRequest {
		t.Fatalf("invalid min_role status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestFolderSearchFiltersRoleBeforeLimitAndHidesUnsafeAncestors(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	owner := fixtureOwner
	viewer := fixtureStranger
	for i := 0; i < 25; i++ {
		folder, err := e.store.CreateFolder(ctx, owner, "Candidate "+string(rune('A'+i)), "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.CreateGrant(ctx, "folder", folder.ID, viewer, repo.RoleViewer, owner); err != nil {
			t.Fatal(err)
		}
	}
	eligible, err := e.store.CreateFolder(ctx, owner, "Candidate Z", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "folder", eligible.ID, viewer, repo.RoleEditor, owner); err != nil {
		t.Fatal(err)
	}
	rr := do(t, e.h, http.MethodGet, "/v1/folders?q=Candidate&min_role=editor", "", map[string]string{"X-Test-Principal": principalHeader(viewer)})
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), eligible.ID) || strings.Count(rr.Body.String(), `"type":"folder"`) != 1 {
		t.Fatalf("editor search was capped before filtering: %s", rr.Body.String())
	}

	privateRoot, err := e.store.CreateFolder(ctx, owner, "Private ancestor", "")
	if err != nil {
		t.Fatal(err)
	}
	sharedChild, err := e.store.CreateFolder(ctx, owner, "Safe child", privateRoot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "folder", sharedChild.ID, viewer, repo.RoleEditor, owner); err != nil {
		t.Fatal(err)
	}
	rr = do(t, e.h, http.MethodGet, "/v1/folders?q=Safe%20child&min_role=editor", "", map[string]string{"X-Test-Principal": principalHeader(viewer)})
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), privateRoot.ID) || strings.Contains(rr.Body.String(), "Private ancestor") {
		t.Fatalf("hidden ancestor leaked from search: %s", rr.Body.String())
	}
	var response struct {
		Items []struct {
			Folder *struct {
				ID             string                  `json:"id"`
				ParentFolderID string                  `json:"parent_folder_id"`
				Ancestors      []repo.FolderBreadcrumb `json:"ancestors"`
				Truncated      bool                    `json:"ancestors_truncated"`
			} `json:"folder"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Items) != 1 || response.Items[0].Folder == nil || response.Items[0].Folder.ID != sharedChild.ID {
		t.Fatalf("search response=%+v", response)
	}
	if response.Items[0].Folder.ParentFolderID != "" || len(response.Items[0].Folder.Ancestors) != 0 || !response.Items[0].Folder.Truncated {
		t.Fatalf("unsafe ancestor metadata=%+v", response.Items[0].Folder)
	}
}

func TestFolderSearchExplicitEmptyQueryHonorsMinimumRole(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	viewer := fixtureStranger

	viewerOnly, err := e.store.CreateFolder(ctx, fixtureOwner, "Viewer only destination", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "folder", viewerOnly.ID, viewer, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	editorDestination, err := e.store.CreateFolder(ctx, fixtureOwner, "Editor destination", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "folder", editorDestination.ID, viewer, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}

	// q= is intentionally different from an omitted q: it requests the
	// autocomplete/search contract, so min_role must filter before the result
	// cap even when the query text is empty.
	rr := do(t, e.h, http.MethodGet, "/v1/folders?q=&min_role=editor", "", map[string]string{
		"X-Test-Principal": principalHeader(viewer),
	})
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), editorDestination.ID) {
		t.Fatalf("editor destination missing from empty-query search: %s", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), viewerOnly.ID) || strings.Contains(rr.Body.String(), viewerOnly.Title) {
		t.Fatalf("viewer-only destination leaked from empty-query editor search: %s", rr.Body.String())
	}
}

func TestFolderSearchAnyoneVisibilityFollowsDeployment(t *testing.T) {
	for _, tt := range []struct {
		name        string
		deployment  string
		wantVisible bool
	}{
		{name: "public link-only folders are not discoverable", deployment: server.DeploymentPublic, wantVisible: false},
		{name: "org-wide folders are discoverable in org deployment", deployment: server.DeploymentOrg, wantVisible: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e := newConfiguredTestEnv(t, server.Config{Environment: "test", Deployment: tt.deployment})
			folderID := createFolder(t, e, `{"title":"Deployment visibility destination"}`, principalHeader(fixtureOwner))
			owner := principalHeader(fixtureOwner)
			grant := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants", `{"principal":{"type":"anyone"},"role":"editor"}`, map[string]string{
				"X-Test-Principal": owner,
				"Content-Type":     "application/json",
			})
			assertStatus(t, grant, http.StatusCreated)

			viewer := principalHeader(fixtureStranger)
			rr := do(t, e.h, http.MethodGet, "/v1/folders?q=Deployment%20visibility&min_role=editor", "", map[string]string{
				"X-Test-Principal": viewer,
			})
			assertStatus(t, rr, http.StatusOK)
			body := rr.Body.String()
			if tt.wantVisible {
				if !strings.Contains(body, folderID) || !strings.Contains(body, "Deployment visibility destination") {
					t.Fatalf("org-wide folder missing from search: %s", body)
				}
				return
			}
			// Public link-only access permits a known link but must not make the
			// folder a global search result. Assert that no identifying metadata is
			// disclosed, not just that the id is absent.
			for _, secret := range []string{folderID, "Deployment visibility destination", fixtureOwner.ID, fixtureOwner.Email, fixtureOwner.Name} {
				if strings.Contains(body, secret) {
					t.Fatalf("public search disclosed folder metadata %q: %s", secret, body)
				}
			}
		})
	}
}

func TestFolderSearchUsesAnyoneRoleAfterPrivateDiscovery(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", Deployment: server.DeploymentPublic})
	ctx := context.Background()
	root, err := e.store.CreateFolder(ctx, fixtureOwner, "Inherited public root", "")
	if err != nil {
		t.Fatal(err)
	}
	child, err := e.store.CreateFolder(ctx, fixtureOwner, "Privately discoverable child", root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "folder", root.ID, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "folder", child.ID, fixtureStranger, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatal(err)
	}

	// The direct viewer grant makes the child discoverable in public search;
	// the inherited anyone editor grant must still contribute to its effective
	// role so min_role=editor does not incorrectly hide it.
	rr := do(t, e.h, http.MethodGet, "/v1/folders?q=Privately%20discoverable%20child&min_role=editor", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), child.ID) {
		t.Fatalf("private discovery did not retain inherited anyone editor role: %s", rr.Body.String())
	}
}
