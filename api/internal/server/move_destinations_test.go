package server_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/googlegroups"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

type moveTreeResponse struct {
	Resource struct {
		CanMove bool `json:"can_move"`
		Source  struct {
			Kind     string `json:"kind"`
			FolderID string `json:"folder_id"`
			Token    string `json:"token"`
		} `json:"source"`
	} `json:"resource"`
	Documents struct {
		Selectable      bool `json:"selectable"`
		Current         bool `json:"current"`
		WouldLoseAccess bool `json:"would_lose_access"`
	} `json:"documents"`
	Path   []string `json:"path"`
	Levels []struct {
		Parent *string `json:"parent"`
		Before string  `json:"before"`
		After  string  `json:"after"`
		Items  []struct {
			ID               string `json:"id"`
			Access           string `json:"access"`
			Selectable       bool   `json:"selectable"`
			Reason           string `json:"reason"`
			Current          bool   `json:"current"`
			HasChildren      bool   `json:"has_children"`
			RestrictedParent bool   `json:"restricted_parent"`
		} `json:"items"`
	} `json:"levels"`
	PathRestrictedPrefix bool   `json:"path_restricted_prefix"`
	Focus                string `json:"focus"`
}

func TestMoveDestinationAnchorNearEndCanPageToFirstSibling(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	folders := make([]string, 60)
	for i := range folders {
		folders[i] = createFolder(t, e, fmt.Sprintf(`{"title":"Folder %02d"}`, i), owner)
	}
	docID, _ := e.createDocument("Pagination resource", "<p>doc</p>", fixtureOwner)
	base := "/v1/move-destinations?resource_type=document&resource_id=" + docID
	anchored := do(t, e.h, http.MethodGet, base+"&reveal="+folders[54], "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, anchored, http.StatusOK)
	var tree moveTreeResponse
	if err := json.Unmarshal(anchored.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	if len(tree.Levels) == 0 || tree.Levels[0].Before == "" {
		t.Fatalf("late anchor must expose earlier siblings: %s", anchored.Body.String())
	}
	seen := make(map[string]bool, 60)
	for _, item := range tree.Levels[0].Items {
		seen[item.ID] = true
	}
	cursor := tree.Levels[0].Before
	for cursor != "" {
		page := do(t, e.h, http.MethodGet, "/v1/move-destinations/children?resource_type=document&resource_id="+docID+"&parent=root&cursor="+url.QueryEscape(cursor), "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, page, http.StatusOK)
		var response struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
			Before string `json:"before"`
		}
		if err := json.Unmarshal(page.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		for _, item := range response.Items {
			if seen[item.ID] {
				t.Fatalf("duplicate folder %s while paging backward", item.ID)
			}
			seen[item.ID] = true
		}
		cursor = response.Before
	}
	if len(seen) != 60 || !seen[folders[0]] {
		t.Fatalf("reachable siblings=%d first=%t", len(seen), seen[folders[0]])
	}
}

func TestMoveDestinationAnchorRecoveryAndLiteralSearch(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	anchor := createFolder(t, e, `{"title":"Anchor"}`, owner)
	after := createFolder(t, e, `{"title":"Bravo"}`, owner)
	parent := createFolder(t, e, `{"title":"Visible parent"}`, owner)
	nonRootAnchor := createFolder(t, e, `{"title":"Nested anchor","parent_folder_id":"`+parent+`"}`, owner)
	literal := createFolder(t, e, `{"title":"Literal %_ marker"}`, owner)
	_ = createFolder(t, e, `{"title":"Literal xx marker"}`, owner)
	docID, _ := e.createDocument("Recovery resource", "<p>doc</p>", fixtureOwner)

	recovery := do(t, e.h, http.MethodGet, "/v1/move-destinations/children?resource_type=document&resource_id="+docID+"&parent=root&anchor="+anchor+"&direction=after", "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, recovery, http.StatusOK)
	if !strings.Contains(recovery.Body.String(), after) || strings.Contains(recovery.Body.String(), `"id":"`+anchor+`"`) {
		t.Fatalf("anchor recovery must be exclusive: %s", recovery.Body.String())
	}
	wrongLevel := do(t, e.h, http.MethodGet, "/v1/move-destinations/children?resource_type=document&resource_id="+docID+"&parent=root&anchor="+nonRootAnchor+"&direction=after", "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, wrongLevel, http.StatusNotFound)

	oneCharacter := do(t, e.h, http.MethodGet, "/v1/move-destinations/search?resource_type=document&resource_id="+docID+"&q=a", "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, oneCharacter, http.StatusBadRequest)
	literalSearch := do(t, e.h, http.MethodGet, "/v1/move-destinations/search?resource_type=document&resource_id="+docID+"&q="+url.QueryEscape("%_"), "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, literalSearch, http.StatusOK)
	if !strings.Contains(literalSearch.Body.String(), literal) || strings.Contains(literalSearch.Body.String(), "Literal xx marker") {
		t.Fatalf("wildcards were not treated literally: %s", literalSearch.Body.String())
	}
}

func TestMoveDestinationPaginationUsesOneCollationOrder(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	titles := []string{"Álpha accented", "alpha plain", "Éclair accented", "eclair plain", "Ömega accented", "omega plain", "Zulu upper", "zulu lower"}
	want := make(map[string]bool, len(titles))
	for _, title := range titles {
		id := createFolder(t, e, `{"title":"`+title+`"}`, owner)
		want[id] = true
	}
	docID, _ := e.createDocument("Collation resource", "<p>doc</p>", fixtureOwner)
	endpoint := "/v1/move-destinations/children?resource_type=document&resource_id=" + docID + "&parent=root&limit=3"
	seen := make(map[string]bool, len(want))
	cursor := ""
	for {
		path := endpoint
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		page := do(t, e.h, http.MethodGet, path, "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, page, http.StatusOK)
		var response struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
			After string `json:"after"`
		}
		if err := json.Unmarshal(page.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		for _, item := range response.Items {
			if seen[item.ID] {
				t.Fatalf("duplicate across collation pages: %s", item.ID)
			}
			seen[item.ID] = true
		}
		cursor = response.After
		if cursor == "" {
			break
		}
	}
	if len(seen) != len(want) {
		t.Fatalf("seen=%d want=%d", len(seen), len(want))
	}
}

func TestMoveDocumentToRootRequiresAccessLossAcknowledgement(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	editor := principalHeader(fixtureStranger)
	source := createFolder(t, e, `{"title":"Inherited editor source"}`, owner)
	if _, err := e.store.CreateGrant(context.Background(), "folder", source, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	docID, _ := e.createDocument("Access loss", "<p>doc</p>", fixtureOwner)
	placed := do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, placed, http.StatusOK)

	bootstrap := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{"X-Test-Principal": editor})
	assertStatus(t, bootstrap, http.StatusOK)
	var tree moveTreeResponse
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	if !tree.Documents.Selectable || !tree.Documents.WouldLoseAccess {
		t.Fatalf("Documents warning missing: %s", bootstrap.Body.String())
	}
	body := `{"destination":{"kind":"root"},"source_token":"` + tree.Resource.Source.Token + `"}`
	withoutAck := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", body, map[string]string{
		"X-Test-Principal": editor, "Content-Type": "application/json",
	})
	if withoutAck.Code != http.StatusConflict || !strings.Contains(withoutAck.Body.String(), "access_loss_confirmation_required") {
		t.Fatalf("without acknowledgement=%d %s", withoutAck.Code, withoutAck.Body.String())
	}

	withAck := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", strings.TrimSuffix(body, "}")+`,"acknowledge_access_loss":true}`, map[string]string{
		"X-Test-Principal": editor, "Content-Type": "application/json",
	})
	assertStatus(t, withAck, http.StatusOK)
	var moved struct {
		Moved      bool            `json:"moved"`
		AccessLost bool            `json:"access_lost"`
		Undo       json.RawMessage `json:"undo"`
	}
	if err := json.Unmarshal(withAck.Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}
	if !moved.Moved || !moved.AccessLost || string(moved.Undo) != "null" {
		t.Fatalf("unsafe access-loss response: %s", withAck.Body.String())
	}
}

func TestMoveDocumentToRootRechecksAccessLossAfterBootstrap(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	editor := principalHeader(fixtureStranger)
	source := createFolder(t, e, `{"title":"Access race source"}`, owner)
	if _, err := e.store.CreateGrant(context.Background(), "folder", source, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	docID, _ := e.createDocument("Access race", "<p>doc</p>", fixtureOwner)
	directGrant, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureStranger, repo.RoleEditor, fixtureOwner)
	if err != nil {
		t.Fatal(err)
	}
	placed := do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, placed, http.StatusOK)

	bootstrap := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{"X-Test-Principal": editor})
	assertStatus(t, bootstrap, http.StatusOK)
	var tree moveTreeResponse
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	if tree.Documents.WouldLoseAccess {
		t.Fatalf("direct editor should retain access at bootstrap: %s", bootstrap.Body.String())
	}
	if err := e.store.DeleteGrant(context.Background(), docID, directGrant.ID, fixtureOwner); err != nil {
		t.Fatal(err)
	}

	moveBody := `{"destination":{"kind":"root"},"source_token":"` + tree.Resource.Source.Token + `"}`
	withoutAck := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", moveBody, map[string]string{
		"X-Test-Principal": editor, "Content-Type": "application/json",
	})
	if withoutAck.Code != http.StatusConflict || !strings.Contains(withoutAck.Body.String(), "access_loss_confirmation_required") {
		t.Fatalf("permission race was not rechecked: %d %s", withoutAck.Code, withoutAck.Body.String())
	}
	current, err := e.store.GetDocument(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	if current.ParentFolderID != source {
		t.Fatalf("unacknowledged race moved document to %q", current.ParentFolderID)
	}
}

func TestMoveDocumentToRootRetainedEditorReceivesUsableUndo(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	editor := principalHeader(fixtureStranger)
	source := createFolder(t, e, `{"title":"Retained editor source"}`, owner)
	if _, err := e.store.CreateGrant(context.Background(), "folder", source, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	docID, _ := e.createDocument("Retained editor", "<p>doc</p>", fixtureOwner)
	if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	placed := do(t, e.h, http.MethodPost, "/v1/folders/"+source+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, placed, http.StatusOK)

	bootstrap := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{"X-Test-Principal": editor})
	assertStatus(t, bootstrap, http.StatusOK)
	var tree moveTreeResponse
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	if tree.Documents.WouldLoseAccess {
		t.Fatalf("direct editor should retain access: %s", bootstrap.Body.String())
	}

	moved := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", `{"destination":{"kind":"root"},"source_token":"`+tree.Resource.Source.Token+`"}`, map[string]string{
		"X-Test-Principal": editor, "Content-Type": "application/json",
	})
	assertStatus(t, moved, http.StatusOK)
	var result struct {
		Moved      bool `json:"moved"`
		AccessLost bool `json:"access_lost"`
		Undo       *struct {
			Destination struct {
				Kind     string `json:"kind"`
				FolderID string `json:"folder_id"`
			} `json:"destination"`
			SourceToken string `json:"source_token"`
		} `json:"undo"`
	}
	if err := json.Unmarshal(moved.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Moved || result.AccessLost || result.Undo == nil || result.Undo.Destination.Kind != "folder" || result.Undo.Destination.FolderID != source {
		t.Fatalf("retained-access response=%s", moved.Body.String())
	}
	undo := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", `{"destination":{"kind":"folder","folder_id":"`+source+`"},"source_token":"`+result.Undo.SourceToken+`"}`, map[string]string{
		"X-Test-Principal": editor, "Content-Type": "application/json",
	})
	assertStatus(t, undo, http.StatusOK)
	current, err := e.store.GetDocument(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	if current.ParentFolderID != source {
		t.Fatalf("undo restored document to %q, want %q", current.ParentFolderID, source)
	}
}

func TestMoveDestinationsBootstrapsCurrentPathAndOpaqueToken(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	a := createFolder(t, e, `{"title":"A"}`, owner)
	b := createFolder(t, e, `{"title":"B","parent_folder_id":"`+a+`"}`, owner)
	c := createFolder(t, e, `{"title":"C","parent_folder_id":"`+b+`"}`, owner)
	docID, _ := e.createDocument("Nested move", "<p>doc</p>", fixtureOwner)

	moveLegacy := do(t, e.h, http.MethodPost, "/v1/folders/"+c+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, moveLegacy, http.StatusOK)

	rr := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, rr, http.StatusOK)
	var response moveTreeResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(response.Path, "/"), strings.Join([]string{a, b, c}, "/"); got != want {
		t.Fatalf("path=%q, want %q", got, want)
	}
	if response.Focus != c || len(response.Levels) != 3 {
		t.Fatalf("focus=%q levels=%d, want %q/3", response.Focus, len(response.Levels), c)
	}
	if response.Resource.Source.Kind != "folder" || response.Resource.Source.FolderID != c {
		t.Fatalf("source=%+v, want visible folder %s", response.Resource.Source, c)
	}
	if !strings.HasPrefix(response.Resource.Source.Token, "ms1.") || strings.Count(response.Resource.Source.Token, ".") != 1 {
		t.Fatalf("source token is not MAC-only: %q", response.Resource.Source.Token)
	}
	mac, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(response.Resource.Source.Token, "ms1."))
	if err != nil || len(mac) != 64 {
		t.Fatalf("source token MAC length=%d err=%v", len(mac), err)
	}
	current := findMoveTreeNode(t, response, c)
	if !current.Current || current.Selectable || current.Reason != "current" {
		t.Fatalf("current node=%+v", current)
	}
	if !findMoveTreeNode(t, response, a).HasChildren || !findMoveTreeNode(t, response, b).HasChildren {
		t.Fatal("expanded ancestors must advertise visible children")
	}
}

func TestMoveDestinationsViewOnlyAndHiddenSourceRescue(t *testing.T) {
	t.Run("view-only folder is visible expandable and disabled", func(t *testing.T) {
		e := newTestEnv(t)
		owner := principalHeader(fixtureOwner)
		stranger := principalHeader(fixtureStranger)
		parent := createFolder(t, e, `{"title":"Shared view"}`, owner)
		_ = createFolder(t, e, `{"title":"Child","parent_folder_id":"`+parent+`"}`, owner)
		if _, err := e.store.CreateGrant(context.Background(), "folder", parent, fixtureStranger, repo.RoleViewer, fixtureOwner); err != nil {
			t.Fatal(err)
		}
		docID, _ := e.createDocument("Editable doc", "<p>doc</p>", fixtureOwner)
		if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
			t.Fatal(err)
		}

		rr := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{"X-Test-Principal": stranger})
		assertStatus(t, rr, http.StatusOK)
		var response moveTreeResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		node := findMoveTreeNode(t, response, parent)
		if node.Access != "view" || node.Selectable || node.Reason != "view_only" || !node.HasChildren {
			t.Fatalf("view-only node=%+v", node)
		}
	})

	t.Run("owner rescues from hidden source without undo disclosure", func(t *testing.T) {
		e := newTestEnv(t)
		owner := principalHeader(fixtureOwner)
		stranger := principalHeader(fixtureStranger)
		hidden := createFolder(t, e, `{"title":"Stranger private"}`, stranger)
		docID, _ := e.createDocument("Rescue", "<p>doc</p>", fixtureOwner)
		if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
			t.Fatal(err)
		}
		moveLegacy := do(t, e.h, http.MethodPost, "/v1/folders/"+hidden+"/documents", `{"document_id":"`+docID+`"}`, map[string]string{
			"X-Test-Principal": stranger, "Content-Type": "application/json",
		})
		assertStatus(t, moveLegacy, http.StatusOK)

		bootstrap := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, bootstrap, http.StatusOK)
		if strings.Contains(bootstrap.Body.String(), hidden) || strings.Contains(bootstrap.Body.String(), "Stranger private") {
			t.Fatalf("hidden source leaked in bootstrap: %s", bootstrap.Body.String())
		}
		var response moveTreeResponse
		if err := json.Unmarshal(bootstrap.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Resource.Source.Kind != "restricted" || response.Resource.Source.FolderID != "" || len(response.Path) != 0 || !response.PathRestrictedPrefix || !response.Resource.CanMove {
			t.Fatalf("restricted source leaked or blocked rescue: %+v path=%v restricted=%t", response.Resource.Source, response.Path, response.PathRestrictedPrefix)
		}

		move := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", `{"destination":{"kind":"root"},"source_token":"`+response.Resource.Source.Token+`"}`, map[string]string{
			"X-Test-Principal": owner, "Content-Type": "application/json",
		})
		assertStatus(t, move, http.StatusOK)
		if strings.Contains(move.Body.String(), hidden) || strings.Contains(move.Body.String(), "Stranger private") {
			t.Fatalf("hidden source leaked in move response: %s", move.Body.String())
		}
		var moved struct {
			Moved bool            `json:"moved"`
			Undo  json.RawMessage `json:"undo"`
		}
		if err := json.Unmarshal(move.Body.Bytes(), &moved); err != nil {
			t.Fatal(err)
		}
		if !moved.Moved || string(moved.Undo) != "null" {
			t.Fatalf("rescue response=%s", move.Body.String())
		}
	})
}

func TestMoveDocumentAuthorizesBeforeComparingSourceToken(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	attacker := principalHeader(fixtureAttacker)
	destination := createFolder(t, e, `{"title":"Private destination"}`, owner)
	docID, _ := e.createDocument("Authorization order", "<p>doc</p>", fixtureOwner)

	request := func(id, body string) *httptest.ResponseRecorder {
		return do(t, e.h, http.MethodPost, "/v1/documents/"+id+"/move", body, map[string]string{
			"X-Test-Principal": attacker, "Content-Type": "application/json",
		})
	}
	invalidToken := "ms1." + strings.Repeat("A", 86)
	unauthorizedDocument := request(docID, `{"destination":{"kind":"root"},"source_token":"`+invalidToken+`"}`)
	if unauthorizedDocument.Code != http.StatusNotFound {
		t.Fatalf("inaccessible document must be indistinguishable from missing: %d %s", unauthorizedDocument.Code, unauthorizedDocument.Body.String())
	}

	if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureAttacker, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	viewerOnly := request(docID, `{"destination":{"kind":"root"},"source_token":"`+invalidToken+`"}`)
	if viewerOnly.Code != http.StatusForbidden {
		t.Fatalf("viewer without editor must remain forbidden: %d %s", viewerOnly.Code, viewerOnly.Body.String())
	}

	if _, err := e.store.CreateGrant(context.Background(), "document", docID, fixtureAttacker, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	unauthorizedDestination := request(docID, `{"destination":{"kind":"folder","folder_id":"`+destination+`"},"source_token":"`+invalidToken+`"}`)
	if unauthorizedDestination.Code == http.StatusConflict || (unauthorizedDestination.Code != http.StatusForbidden && unauthorizedDestination.Code != http.StatusNotFound) {
		t.Fatalf("destination auth must precede token check: %d %s", unauthorizedDestination.Code, unauthorizedDestination.Body.String())
	}

	missing := request("doc_missing", `{"destination":{"kind":"root"},"source_token":"`+invalidToken+`"}`)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing document must be 404 before token check: %d %s", missing.Code, missing.Body.String())
	}
	if missing.Body.String() != unauthorizedDocument.Body.String() {
		t.Fatalf("document existence leaked: inaccessible=%s missing=%s", unauthorizedDocument.Body.String(), missing.Body.String())
	}
}

func TestMoveDestinationsNeverLeakHiddenAncestorAcrossReadEndpoints(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	viewer := principalHeader(fixtureStranger)
	hidden := createFolder(t, e, `{"title":"Hidden ancestor canary"}`, owner)
	visible := createFolder(t, e, `{"title":"Visible child canary","parent_folder_id":"`+hidden+`"}`, owner)
	if _, err := e.store.CreateGrant(context.Background(), "folder", visible, fixtureStranger, repo.RoleEditor, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	docID, _ := e.createDocument("Leak canary resource", "<p>doc</p>", fixtureStranger)

	assertNoHiddenAncestor := func(name string, rr *httptest.ResponseRecorder) {
		t.Helper()
		assertStatus(t, rr, http.StatusOK)
		body := rr.Body.String()
		if strings.Contains(body, hidden) || strings.Contains(body, "Hidden ancestor canary") {
			t.Fatalf("%s leaked hidden ancestor: %s", name, body)
		}
	}
	base := "/v1/move-destinations?resource_type=document&resource_id=" + docID
	assertNoHiddenAncestor("reveal", do(t, e.h, http.MethodGet, base+"&reveal="+visible, "", map[string]string{"X-Test-Principal": viewer}))
	assertNoHiddenAncestor("children", do(t, e.h, http.MethodGet, "/v1/move-destinations/children?resource_type=document&resource_id="+docID+"&parent=root", "", map[string]string{"X-Test-Principal": viewer}))
	assertNoHiddenAncestor("search", do(t, e.h, http.MethodGet, "/v1/move-destinations/search?resource_type=document&resource_id="+docID+"&q=Visible%20child", "", map[string]string{"X-Test-Principal": viewer}))

	hiddenReveal := do(t, e.h, http.MethodGet, base+"&reveal="+hidden, "", map[string]string{"X-Test-Principal": viewer})
	assertStatus(t, hiddenReveal, http.StatusNotFound)
	if strings.Contains(hiddenReveal.Body.String(), hidden) || strings.Contains(hiddenReveal.Body.String(), "Hidden ancestor canary") {
		t.Fatalf("hidden reveal error leaked ancestor: %s", hiddenReveal.Body.String())
	}
}

func TestMoveDocumentTokenStaleReplayAndUndo(t *testing.T) {
	e := newTestEnv(t)
	owner := principalHeader(fixtureOwner)
	destination := createFolder(t, e, `{"title":"Destination"}`, owner)
	docID, _ := e.createDocument("Token move", "<p>doc</p>", fixtureOwner)

	bootstrap := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, bootstrap, http.StatusOK)
	var tree moveTreeResponse
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	moveBody := `{"destination":{"kind":"folder","folder_id":"` + destination + `"},"source_token":"` + tree.Resource.Source.Token + `"}`
	move := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", moveBody, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, move, http.StatusOK)
	var moved struct {
		Moved bool `json:"moved"`
		Undo  *struct {
			Destination struct {
				Kind string `json:"kind"`
			} `json:"destination"`
			SourceToken string `json:"source_token"`
		} `json:"undo"`
	}
	if err := json.Unmarshal(move.Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}
	if !moved.Moved || moved.Undo == nil || moved.Undo.Destination.Kind != "root" {
		t.Fatalf("move response=%s", move.Body.String())
	}

	replay := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", moveBody, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, replay, http.StatusConflict)
	if !strings.Contains(replay.Body.String(), `"source_changed"`) {
		t.Fatalf("replay error=%s", replay.Body.String())
	}

	undo := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/move", `{"destination":{"kind":"root"},"source_token":"`+moved.Undo.SourceToken+`"}`, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, undo, http.StatusOK)
	doc, err := e.store.GetDocument(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.ParentFolderID != "" {
		t.Fatalf("undo left document in %q", doc.ParentFolderID)
	}
}

func TestMoveDestinationFolderExclusionAndDeploymentDiscovery(t *testing.T) {
	t.Run("moving folder subtree is excluded from search", func(t *testing.T) {
		e := newTestEnv(t)
		owner := principalHeader(fixtureOwner)
		parent := createFolder(t, e, `{"title":"Move parent"}`, owner)
		child := createFolder(t, e, `{"title":"Excluded child","parent_folder_id":"`+parent+`"}`, owner)
		rr := do(t, e.h, http.MethodGet, "/v1/move-destinations/search?resource_type=folder&resource_id="+parent+"&q=Excluded", "", map[string]string{"X-Test-Principal": owner})
		assertStatus(t, rr, http.StatusOK)
		if strings.Contains(rr.Body.String(), child) {
			t.Fatalf("folder subtree leaked into destinations: %s", rr.Body.String())
		}
	})

	for _, test := range []struct {
		name       string
		deployment string
		visible    bool
	}{
		{name: "public keeps anyone-only folders link-only", deployment: server.DeploymentPublic},
		{name: "org discovers anyone folders", deployment: server.DeploymentOrg, visible: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			e := newConfiguredTestEnv(t, server.Config{Environment: "test", Deployment: test.deployment})
			folder := createFolder(t, e, `{"title":"Everyone destination"}`, principalHeader(fixtureOwner))
			grant := do(t, e.h, http.MethodPost, "/v1/folders/"+folder+"/grants", `{"principal":{"type":"anyone"},"role":"editor"}`, map[string]string{
				"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json",
			})
			assertStatus(t, grant, http.StatusCreated)
			docID, _ := e.createDocument("Discovery", "<p>doc</p>", fixtureStranger)
			rr := do(t, e.h, http.MethodGet, "/v1/move-destinations/search?resource_type=document&resource_id="+docID+"&q=Everyone", "", map[string]string{"X-Test-Principal": principalHeader(fixtureStranger)})
			assertStatus(t, rr, http.StatusOK)
			if got := strings.Contains(rr.Body.String(), folder); got != test.visible {
				t.Fatalf("visible=%t want %t body=%s", got, test.visible, rr.Body.String())
			}
		})
	}
}

func TestMoveDestinationRootIncludesGoogleGroupEntryWithoutHiddenParent(t *testing.T) {
	group := googlegroups.GoogleGroup{ID: "groups/move-tree", CustomerID: "C123", Email: "move-tree@example.com", Name: "Move tree"}
	directory := &postgresGroupDirectory{
		group: group,
		memberships: map[string][]googlegroups.GoogleGroup{
			fixtureStranger.Email: {group},
		},
	}
	e := newConfiguredTestEnv(t, server.Config{
		Environment:               server.EnvProduction,
		Deployment:                server.DeploymentOrg,
		GoogleGroupsEnabled:       true,
		GoogleGroupsMembershipTTL: time.Nanosecond,
	}, server.WithGoogleGroupDirectory(directory))
	owner := principalHeader(fixtureOwner)
	hidden := createFolder(t, e, `{"title":"Hidden group parent"}`, owner)
	shared := createFolder(t, e, `{"title":"Group destination","parent_folder_id":"`+hidden+`"}`, owner)
	grant := do(t, e.h, http.MethodPost, "/v1/folders/"+shared+"/grants", `{"principal":{"type":"google_group","email":"move-tree@example.com"},"role":"editor"}`, map[string]string{
		"X-Test-Principal": owner, "Content-Type": "application/json",
	})
	assertStatus(t, grant, http.StatusCreated)
	docID, _ := e.createDocument("Group move resource", "<p>doc</p>", fixtureStranger)

	rr := do(t, e.h, http.MethodGet, "/v1/move-destinations?resource_type=document&resource_id="+docID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), shared) {
		t.Fatalf("group access entry missing from root: %s", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), hidden) || strings.Contains(rr.Body.String(), "Hidden group parent") {
		t.Fatalf("group root leaked hidden parent: %s", rr.Body.String())
	}
	var tree moveTreeResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	if node := findMoveTreeNode(t, tree, shared); !node.RestrictedParent || !node.Selectable {
		t.Fatalf("group root node=%+v", node)
	}
}

func findMoveTreeNode(t *testing.T, response moveTreeResponse, id string) struct {
	ID               string `json:"id"`
	Access           string `json:"access"`
	Selectable       bool   `json:"selectable"`
	Reason           string `json:"reason"`
	Current          bool   `json:"current"`
	HasChildren      bool   `json:"has_children"`
	RestrictedParent bool   `json:"restricted_parent"`
} {
	t.Helper()
	for _, level := range response.Levels {
		for _, item := range level.Items {
			if item.ID == id {
				return item
			}
		}
	}
	t.Fatalf("node %q not found in %+v", id, response)
	return struct {
		ID               string `json:"id"`
		Access           string `json:"access"`
		Selectable       bool   `json:"selectable"`
		Reason           string `json:"reason"`
		Current          bool   `json:"current"`
		HasChildren      bool   `json:"has_children"`
		RestrictedParent bool   `json:"restricted_parent"`
	}{}
}
