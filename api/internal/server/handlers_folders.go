package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func (h handlers) needFolderRole(c *gin.Context, id string, need repo.Role) bool {
	_, ok := h.needFolderChain(c, id, need)
	return ok
}

// needFolderChain makes sure the caller has at least need on the folder and
// returns the folder's access chain. A folder that does not exist is a 404,
// like a document that does not exist.
func (h handlers) needFolderChain(c *gin.Context, id string, need repo.Role) ([]repo.FolderAccess, bool) {
	chain, err := h.deps.repository.FolderAccessChain(c.Request.Context(), *current(c), id)
	switch {
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
		return nil, false
	case err != nil:
		// A lookup failure is a server fault, not a permission verdict.
		internalErr(c, err)
		return nil, false
	}
	if !atLeast(chain[len(chain)-1].Role, need) {
		if groupMembershipUnavailable(current(c)) {
			groupMembershipUnavailableResponse(c)
			return nil, false
		}
		forbidden(c, string(need)+" role required")
		return nil, false
	}
	return chain, true
}

// needDocMove makes sure the caller can move a document to folder to ("" is
// the root). The caller needs editor on the document. Like Google Drive's
// canRemoveChildren, the caller also needs editor on the folder that the
// document leaves, because the move removes the access that folder gives.
// The owner skips that check, so no one can trap a document away from them.
func (h handlers) needDocMove(c *gin.Context, docID, to string) bool {
	doc, err := h.deps.repository.GetDocument(c.Request.Context(), docID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return false
		}
		internalErr(c, err)
		return false
	}
	role, err := h.deps.repository.RoleForDocument(c.Request.Context(), *current(c), docID)
	if err != nil {
		internalErr(c, err)
		return false
	}
	if doc.ParentFolderID == to && atLeast(role, repo.RoleEditor) {
		return true
	}
	canMove, err := h.canMoveDoc(c, doc, role)
	switch {
	case err != nil:
		internalErr(c, err)
	case !canMove && groupMembershipUnavailable(current(c)):
		groupMembershipUnavailableResponse(c)
	case !canMove:
		forbidden(c, "editor role on the document and on its folder is required")
	}
	return err == nil && canMove
}

// canMoveDoc reports whether the caller, with role on doc, may take doc out
// of its folder: see needDocMove.
func (h handlers) canMoveDoc(c *gin.Context, doc repo.Document, role repo.Role) (bool, error) {
	switch {
	case !atLeast(role, repo.RoleEditor):
		return false, nil
	case role == repo.RoleOwner || doc.ParentFolderID == "":
		return true, nil
	}
	folderRole, err := h.deps.repository.RoleForFolder(c.Request.Context(), *current(c), doc.ParentFolderID)
	return atLeast(folderRole, repo.RoleEditor), err
}

// folderListResponse is the payload of GET /v1/folders.
type folderListResponse struct {
	Folder  *repo.Folder       `json:"folder"`
	Items   []repo.FolderEntry `json:"items"`
	HasMore bool               `json:"has_more"`
}

type accessResponse struct {
	Items          []repo.EffectiveAccessItem `json:"items"`
	CurrentRole    repo.Role                  `json:"current_role"`
	CanonicalOwner bool                       `json:"canonical_owner"`
}

func samePrincipal(a, b auth.Principal) bool {
	return a.Type != "" && a.Type == b.Type && a.ID != "" && a.ID == b.ID
}

// permissionWarning flags a move that may broaden who can see the moved
// resource.
type permissionWarning struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func mayBroadenAccessWarning(message string) *permissionWarning {
	return &permissionWarning{Kind: "may_broaden_access", Message: message}
}

const folderDocumentWarningMessage = "Others have access to this folder — everyone with access may see this document."

// folderDocumentWarning warns that the people who can see the folder can see
// a document of owner that was put in it. The warning is not essential, so a
// failed lookup gives no warning.
func (h handlers) folderDocumentWarning(c *gin.Context, folderID string, owner auth.Principal) *permissionWarning {
	if folderID == "" {
		return nil
	}
	if mayBroaden, err := h.deps.repository.FolderMayBroadenAccess(c.Request.Context(), folderID, owner); err != nil || !mayBroaden {
		return nil
	}
	return mayBroadenAccessWarning(folderDocumentWarningMessage)
}

// updateFolderResponse is the payload of PATCH /v1/folders/{id}.
type updateFolderResponse struct {
	ID                string             `json:"id"`
	Title             string             `json:"title"`
	Owner             auth.Principal     `json:"owner"`
	ParentFolderID    string             `json:"parent_folder_id"`
	PermissionWarning *permissionWarning `json:"permission_warning,omitempty"`
}

// moveDocResponse is the payload of POST /v1/folders/{id}/documents.
type moveDocResponse struct {
	DocumentID        string             `json:"document_id"`
	FolderID          string             `json:"folder_id"`
	Moved             bool               `json:"moved"`
	PermissionWarning *permissionWarning `json:"permission_warning,omitempty"`
}

// ambiguousPathResponse reports a folder path that matches several folders.
type ambiguousPathResponse struct {
	Error      errorBody     `json:"error"`
	Candidates []repo.Folder `json:"candidates"`
}

func (h handlers) createFolder(c *gin.Context) {
	var in struct {
		Title          string `json:"title"`
		ParentFolderID string `json:"parent_folder_id"`
	}
	if !requireJSON(c) {
		return
	}
	if c.ShouldBindJSON(&in) != nil || in.Title == "" {
		badRequest(c, "invalid folder")
		return
	}
	if in.ParentFolderID != "" && !h.needFolderRole(c, in.ParentFolderID, repo.RoleEditor) {
		return
	}
	f, err := h.deps.repository.CreateFolder(c.Request.Context(), *current(c), in.Title, in.ParentFolderID)
	if err != nil {
		if errors.Is(err, repo.ErrConflict) {
			c.JSON(http.StatusConflict, errorResponse("conflict", "A folder named \""+in.Title+"\" already exists here.", nil))
			return
		}
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, f)
}

// listFolders godoc
// @Summary List or search folders
// @Description With no parameters, lists the folders and documents at the root of the caller. With folder_id or path, lists the contents of that folder. With q or min_role, searches the folders that the caller can see by title, at most 25: min_role keeps only the folders on which the caller has at least that role, and min_role with no q lists every such folder, for a picker such as the move dialog.
// @Tags folders
// @Security bearerAuth
// @Security cookieAuth
// @Param folder_id query string false "Folder ID to list"
// @Param path query string false "Folder path to list, such as /A/B"
// @Param q query string false "Words of a folder title"
// @Param min_role query string false "Least role of the caller on each folder of a search" Enums(viewer, commenter, editor, owner)
// @Success 200 {object} folderListResponse
// @Failure 404 {object} errorEnvelope
// @Failure 409 {object} ambiguousPathResponse "ambiguous_path: more than one folder has a name of the path"
// @Router /v1/folders [get]
func (h handlers) listFolders(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	// An explicitly supplied q (including q=) is the autocomplete/search
	// contract. A request without q retains the workspace browsing behavior.
	q, hasQuery := c.GetQuery("q")
	if hasQuery {
		includeOrgWide := h.deps.deployment == DeploymentOrg
		minRole, ok := parseFolderSearchRole(c.Query("min_role"))
		if !ok {
			badRequest(c, "invalid min_role")
			return
		}
		folders, err := h.deps.repository.SearchFoldersByTitle(c.Request.Context(), *current(c), q, includeOrgWide, minRole, 25)
		if err != nil {
			internalErr(c, err)
			return
		}
		items := make([]repo.FolderEntry, 0, len(folders))
		for i := range folders {
			items = append(items, repo.FolderEntry{Type: "folder", Folder: &folders[i]})
		}
		c.JSON(http.StatusOK, folderListResponse{Items: items, HasMore: len(folders) >= 25})
		return
	}
	folderID := c.Query("folder_id")
	if folderID != "" {
		if !h.needFolderRole(c, folderID, repo.RoleViewer) {
			return
		}
	}
	items, has, folder, err := h.deps.repository.ListFolder(c.Request.Context(), *current(c), folderID, c.Query("path"))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		var ambErr *repo.AmbiguousPathError
		if errors.As(err, &ambErr) {
			c.JSON(http.StatusConflict, ambiguousPathResponse{
				Error: errorBody{
					Code:    "ambiguous_path",
					Message: "Multiple folders named \"" + ambErr.Segment + "\" found. Use --folder-id to specify.",
				},
				Candidates: ambErr.Candidates,
			})
			return
		}
		internalErr(c, err)
		return
	}
	if folder != nil && folderID == "" {
		if !h.needFolderRole(c, folder.ID, repo.RoleViewer) {
			return
		}
	}
	if folder != nil {
		chain, err := h.deps.repository.FolderAccessChain(c.Request.Context(), *current(c), folder.ID)
		if err != nil {
			internalErr(c, err)
			return
		}
		filterVisibleFolderAncestors(folder, chain)
	}
	c.JSON(http.StatusOK, folderListResponse{Folder: folder, Items: items, HasMore: has})
}
func (h handlers) searchFolders(c *gin.Context, q string, minRole repo.Role) {
	if _, known := roleRank[minRole]; minRole != "" && !known {
		badRequest(c, "invalid min_role")
		return
	}
	includeOrgWide := h.deps.deployment == DeploymentOrg
	folders, err := h.deps.repository.SearchFoldersByTitle(c.Request.Context(), *current(c), q, includeOrgWide, minRole, 25)
	if err != nil {
		internalErr(c, err)
		return
	}
	items := make([]repo.FolderEntry, 0, len(folders))
	for i := range folders {
		items = append(items, repo.FolderEntry{Type: "folder", Folder: &folders[i]})
	}
	c.JSON(http.StatusOK, folderListResponse{Items: items, HasMore: len(folders) >= 25})
}
func (h handlers) getFolder(c *gin.Context) {
	p := current(c)
	// One query resolves the caller's role on the folder and on every
	// ancestor, replacing a per-ancestor role lookup.
	chain, ok := h.needFolderChain(c, c.Param("id"), repo.RoleViewer)
	if !ok {
		return
	}
	f, err := h.deps.repository.GetFolder(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	if p.Type != f.Owner.Type || p.ID != f.Owner.ID {
		_ = h.deps.repository.RecordFolderOpened(c.Request.Context(), f.ID, *p)
	}
	filterVisibleFolderAncestors(&f, chain)
	c.JSON(http.StatusOK, f)
}

func parseFolderSearchRole(raw string) (repo.Role, bool) {
	switch raw {
	case "", string(repo.RoleViewer):
		if raw == "" {
			return repo.RoleNone, true
		}
		return repo.RoleViewer, true
	case string(repo.RoleCommenter):
		return repo.RoleCommenter, true
	case string(repo.RoleEditor):
		return repo.RoleEditor, true
	case string(repo.RoleOwner):
		return repo.RoleOwner, true
	default:
		return repo.RoleNone, false
	}
}

// filterVisibleFolderAncestors keeps the root-first contiguous suffix nearest
// the requested folder. Any hidden prefix is represented only by the boolean;
// hidden ids/titles are never serialized.
func filterVisibleFolderAncestors(f *repo.Folder, chain []repo.FolderAccess) {
	if f == nil || len(f.Ancestors) == 0 || len(chain) == 0 {
		return
	}
	roles := make(map[string]repo.Role, len(chain))
	for _, a := range chain {
		roles[a.ID] = a.Role
	}
	visibleFrom := len(f.Ancestors)
	for i := len(f.Ancestors) - 1; i >= 0; i-- {
		if atLeast(roles[f.Ancestors[i].ID], repo.RoleViewer) {
			visibleFrom = i
		} else {
			break
		}
	}
	if visibleFrom > 0 {
		f.AncestorsTruncated = true
		if visibleFrom == len(f.Ancestors) {
			// The immediate parent is part of the hidden prefix. Keep its id
			// out of the additive legacy field as well as breadcrumbs.
			f.ParentFolderID = ""
		}
	}
	f.Ancestors = f.Ancestors[visibleFrom:]
}
func (h handlers) patchFolder(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleOwner) {
		return
	}
	// Use json.RawMessage to distinguish absent field from explicit null.
	var raw struct {
		Title          string          `json:"title"`
		ParentFolderID json.RawMessage `json:"parent_folder_id"`
	}
	if !requireJSON(c) {
		return
	}
	if c.ShouldBindJSON(&raw) != nil {
		badRequest(c, "invalid folder")
		return
	}
	parentPtr, err := folderParentUpdate(raw.ParentFolderID)
	if err != nil {
		badRequest(c, "invalid parent_folder_id")
		return
	}
	if parentPtr != nil && *parentPtr != "" {
		if !h.needFolderRole(c, *parentPtr, repo.RoleEditor) {
			return
		}
	}
	f, err := h.deps.repository.UpdateFolder(c.Request.Context(), c.Param("id"), raw.Title, parentPtr)
	if err != nil {
		respondFolderUpdateError(c, err)
		return
	}
	if parentPtr != nil {
		h.folderAccessChanged(c)
	}
	out := updateFolderResponse{ID: f.ID, Title: f.Title, Owner: f.Owner, ParentFolderID: f.ParentFolderID}
	if parentPtr != nil && *parentPtr != "" {
		// The warning is advisory; a failed grant lookup must not fail the move.
		if mayBroaden, err := h.deps.repository.FolderMayBroadenAccess(c.Request.Context(), *parentPtr, f.Owner); err == nil && mayBroaden {
			out.PermissionWarning = mayBroadenAccessWarning("Others have access to the destination folder — contents of the moved folder may become visible to them.")
		}
	}
	c.JSON(http.StatusOK, out)
}

func folderParentUpdate(raw json.RawMessage) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	if string(raw) == "null" {
		empty := ""
		return &empty, nil
	}
	var parentID string
	if err := json.Unmarshal(raw, &parentID); err != nil {
		return nil, err
	}
	return &parentID, nil
}

func respondFolderUpdateError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, repo.ErrConflict):
		c.JSON(http.StatusConflict, errorResponse("conflict", "A folder with that name already exists in the destination.", nil))
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
	default:
		internalErr(c, err)
	}
}

func (h handlers) deleteFolder(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleOwner) {
		return
	}
	if err := h.deps.repository.DeleteFolder(c.Request.Context(), c.Param("id"), *current(c)); err != nil {
		switch {
		case errors.Is(err, repo.ErrForbidden):
			forbidden(c, "owner role required")
		case errors.Is(err, repo.ErrNotFound):
			notFound(c)
		default:
			internalErr(c, err)
		}
		return
	}
	h.folderAccessChanged(c)
	c.Status(http.StatusNoContent)
}

func (h handlers) folderAccess(c *gin.Context) {
	chain, ok := h.needFolderChain(c, c.Param("id"), repo.RoleViewer)
	if !ok {
		return
	}
	folder, err := h.deps.repository.GetFolder(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	items, err := h.deps.repository.ListEffectiveAccess(c.Request.Context(), "folder", c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, accessResponse{Items: items, CurrentRole: chain[len(chain)-1].Role, CanonicalOwner: samePrincipal(*current(c), folder.Owner)})
}
func (h handlers) documentAccess(c *gin.Context) {
	role, err := h.deps.repository.RoleForDocument(c.Request.Context(), *current(c), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	if !atLeast(role, repo.RoleViewer) {
		if groupMembershipUnavailable(current(c)) {
			groupMembershipUnavailableResponse(c)
			return
		}
		forbidden(c, "viewer role required")
		return
	}
	document, err := h.deps.repository.GetDocument(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	items, err := h.deps.repository.ListEffectiveAccess(c.Request.Context(), "document", c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, accessResponse{Items: items, CurrentRole: role, CanonicalOwner: samePrincipal(*current(c), document.Owner)})
}

func (h handlers) listFolderDocs(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	if !h.needFolderRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	docs, err := h.deps.repository.ListFolderDocuments(c.Request.Context(), *current(c), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.Document]{Items: docs})
}

// moveDocToFolder godoc
// @Summary Move a document into a folder
// @Description The caller needs the editor role on the document and on the folder. The caller also needs the editor role on the folder that the document leaves, unless the caller owns the document. permission_warning is set when the folder gives access to more people than the document had.
// @Tags folders
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Folder ID"
// @Param body body object{document_id=string} true "The document to move"
// @Success 200 {object} moveDocResponse
// @Failure 403 {object} errorEnvelope
// @Failure 404 {object} errorEnvelope
// @Router /v1/folders/{id}/documents [post]
func (h handlers) moveDocToFolder(c *gin.Context) {
	folderID := c.Param("id")
	var in struct {
		DocumentID     string          `json:"document_id"`
		ExpectedSource json.RawMessage `json:"expected_source"`
	}
	if !requireJSON(c) {
		return
	}
	if c.ShouldBindJSON(&in) != nil || in.DocumentID == "" {
		badRequest(c, "invalid document")
		return
	}
	expectedSource, err := parseExpectedMoveSource(in.ExpectedSource)
	if err != nil {
		badRequest(c, "invalid expected_source")
		return
	}
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	result, err := h.deps.repository.MoveDocumentToFolder(c.Request.Context(), *current(c), folderID, in.DocumentID, expectedSource)
	if err != nil {
		respondDocumentMoveError(c, err)
		return
	}
	if result.Moved {
		h.accessChanged(c, in.DocumentID)
	}
	out := moveDocResponse{DocumentID: in.DocumentID, FolderID: folderID, Moved: result.Moved}
	if result.PermissionWarning {
		out.PermissionWarning = mayBroadenAccessWarning(folderDocumentWarningMessage)
	}
	c.JSON(http.StatusOK, out)
}

// moveDocToRoot godoc
// @Summary Move a document out of a folder to the root
// @Description The caller needs the editor role on the document, and on the folder that it leaves unless the caller owns the document.
// @Tags folders
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Folder ID"
// @Param doc_id path string true "Document ID"
// @Success 204
// @Failure 403 {object} errorEnvelope
// @Failure 404 {object} errorEnvelope
// @Router /v1/folders/{id}/documents/{doc_id} [delete]
func (h handlers) moveDocToRoot(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	if _, err := h.deps.repository.MoveDocumentToRoot(c.Request.Context(), *current(c), c.Param("id"), c.Param("doc_id")); err != nil {
		respondDocumentMoveError(c, err)
		return
	}
	h.accessChanged(c, c.Param("doc_id"))
	c.Status(http.StatusNoContent)
}

func parseExpectedMoveSource(raw json.RawMessage) (*repo.MoveSource, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("null expected_source")
	}
	var in struct {
		Kind     string `json:"kind"`
		FolderID string `json:"folder_id"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	switch in.Kind {
	case "root":
		if in.FolderID != "" {
			return nil, errors.New("root source cannot have folder_id")
		}
		return &repo.MoveSource{Kind: "root"}, nil
	case "folder":
		if in.FolderID == "" {
			return nil, errors.New("folder source needs folder_id")
		}
		return &repo.MoveSource{Kind: "folder", FolderID: in.FolderID}, nil
	default:
		return nil, errors.New("unknown source kind")
	}
}

func respondDocumentMoveError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, repo.ErrSourceChanged):
		c.JSON(http.StatusConflict, errorResponse("source_changed", "document source changed; refresh and retry", nil))
	case errors.Is(err, repo.ErrForbidden):
		if groupMembershipUnavailable(current(c)) {
			groupMembershipUnavailableResponse(c)
			return
		}
		forbidden(c, "editor role on the document and move source/destination is required")
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
	default:
		internalErr(c, err)
	}
}

// CreateFolderGrant godoc
// @Summary Create folder grant
// @Tags grants
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Folder ID"
// @Param grant body grantInput true "Grant target and role; google_group principals are resolved from principal.email"
// @Success 201 {object} repo.Grant
// @Failure 429 {object} errorEnvelope
// @Router /v1/folders/{id}/grants [post]
func (h handlers) createFolderGrant(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	var in grantInput
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil || !validGrantRole(in.Role) {
		badRequest(c, "invalid grant")
		return
	}
	principal := auth.Principal{Type: in.Principal.Type, ID: in.Principal.ID, Email: in.Principal.Email, Name: in.Principal.Name}
	resolved, err := resolveGrantPrincipal(c, h.deps.repository, h.deps.googleGroupDirectory, h.deps.googleGroupsEnabled, in.Address, principal)
	if err != nil {
		respondGrantPrincipalError(c, err, in.Principal.Type)
		return
	}
	g, err := h.deps.repository.CreateGrant(c.Request.Context(), "folder", c.Param("id"), resolved, in.Role, *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	if resolved.Type == auth.PrincipalGoogleGroup {
		incGoogleGroupOperation("grant_resolution", "success")
	}
	g.ResourceType, g.ResourceID = "folder", c.Param("id")
	c.JSON(http.StatusCreated, g)
}
func (h handlers) patchFolderGrant(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	var in struct {
		Role repo.Role `json:"role"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil || !validGrantRole(in.Role) {
		badRequest(c, "invalid grant")
		return
	}
	g, err := h.deps.repository.UpdateGrant(c.Request.Context(), c.Param("id"), c.Param("grant_id"), in.Role, *current(c))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	h.folderAccessChanged(c)
	c.JSON(http.StatusOK, g)
}
func (h handlers) deleteFolderGrant(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	if err := h.deps.repository.DeleteGrant(c.Request.Context(), c.Param("id"), c.Param("grant_id"), *current(c)); err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	h.folderAccessChanged(c)
	c.Status(http.StatusNoContent)
}
