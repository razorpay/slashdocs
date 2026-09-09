package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/aidocs/api/internal/auth"
	"github.com/razorpay/aidocs/api/internal/repo"
)

func (h handlers) needFolderRole(c *gin.Context, id string, need repo.Role) bool {
	role, err := h.deps.repository.RoleForFolder(c.Request.Context(), *current(c), id)
	if err != nil {
		// A lookup failure is a server fault, not a permission verdict.
		internalErr(c, err)
		return false
	}
	if !atLeast(role, need) {
		if groupMembershipUnavailable(current(c)) {
			groupMembershipUnavailableResponse(c)
			return false
		}
		forbidden(c, string(need)+" role required")
		return false
	}
	return true
}

// folderListResponse is the payload of GET /v1/folders.
type folderListResponse struct {
	Folder  *repo.Folder       `json:"folder"`
	Items   []repo.FolderEntry `json:"items"`
	HasMore bool               `json:"has_more"`
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
func (h handlers) listFolders(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	if q := c.Query("q"); q != "" {
		includeOrgWide := h.deps.deployment == DeploymentOrg
		folders, err := h.deps.repository.SearchFoldersByTitle(c.Request.Context(), *current(c), q, includeOrgWide, 25)
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
	c.JSON(http.StatusOK, folderListResponse{Folder: folder, Items: items, HasMore: has})
}
func (h handlers) getFolder(c *gin.Context) {
	p := current(c)
	// One query resolves the caller's role on the folder and on every
	// ancestor, replacing a per-ancestor role lookup.
	chain, err := h.deps.repository.FolderAccessChain(c.Request.Context(), *p, c.Param("id"))
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		internalErr(c, err)
		return
	}
	if len(chain) == 0 || !atLeast(chain[len(chain)-1].Role, repo.RoleViewer) {
		forbidden(c, "viewer role required")
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
	// Filter ancestors to only those the viewer can access (bottom-up).
	if len(f.Ancestors) > 0 {
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
		f.Ancestors = f.Ancestors[visibleFrom:]
	}
	c.JSON(http.StatusOK, f)
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
	out := updateFolderResponse{ID: f.ID, Title: f.Title, Owner: f.Owner, ParentFolderID: f.ParentFolderID}
	if parentPtr != nil && *parentPtr != "" {
		// The warning is advisory; a failed grant lookup must not fail the move.
		if hasGrants, err := h.deps.repository.FolderHasGrants(c.Request.Context(), *parentPtr); err == nil && hasGrants {
			out.PermissionWarning = mayBroadenAccessWarning("The destination folder has active grants — contents of the moved folder may become visible to others.")
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
	c.Status(http.StatusNoContent)
}
func (h handlers) folderAccess(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	items, err := h.deps.repository.ListEffectiveAccess(c.Request.Context(), "folder", c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.EffectiveAccessItem]{Items: items})
}
func (h handlers) documentAccess(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	items, err := h.deps.repository.ListEffectiveAccess(c.Request.Context(), "document", c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.EffectiveAccessItem]{Items: items})
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
func (h handlers) moveDocToFolder(c *gin.Context) {
	folderID := c.Param("id")
	if !h.needFolderRole(c, folderID, repo.RoleEditor) {
		return
	}
	var in struct {
		DocumentID string `json:"document_id"`
	}
	if !requireJSON(c) {
		return
	}
	if c.ShouldBindJSON(&in) != nil || in.DocumentID == "" {
		badRequest(c, "invalid document")
		return
	}
	p := current(c)
	docRole, err := h.deps.repository.RoleForDocument(c.Request.Context(), *p, in.DocumentID)
	if err != nil {
		internalErr(c, err)
		return
	}
	if !atLeast(docRole, repo.RoleEditor) {
		forbidden(c, "editor role on the document is required")
		return
	}
	hasGrants, err := h.deps.repository.MoveDocumentToFolder(c.Request.Context(), *p, folderID, in.DocumentID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	out := moveDocResponse{DocumentID: in.DocumentID, FolderID: folderID, Moved: true}
	if hasGrants {
		out.PermissionWarning = mayBroadenAccessWarning("This folder has active grants — everyone with access may see this document.")
	}
	c.JSON(http.StatusOK, out)
}
func (h handlers) moveDocToRoot(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	p := current(c)
	docRole, err := h.deps.repository.RoleForDocument(c.Request.Context(), *p, c.Param("doc_id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	if !atLeast(docRole, repo.RoleEditor) {
		forbidden(c, "editor role on the document is required")
		return
	}
	if err := h.deps.repository.MoveDocumentToRoot(c.Request.Context(), c.Param("id"), c.Param("doc_id")); err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// CreateFolderGrant godoc
// @Summary Create folder grant
// @Tags grants
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Folder ID"
// @Param grant body grantInput true "Grant target and role; google_group principals are resolved from principal.email"
// @Success 201 {object} repo.Grant
// @Router /v1/folders/{id}/grants [post]
func (h handlers) createFolderGrant(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleCommenter) {
		return
	}
	var in grantInput
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil || !validGrantRoleForPrincipal(in.Principal.Type, in.Role) {
		badRequest(c, "invalid grant")
		return
	}
	principal := auth.Principal{Type: in.Principal.Type, ID: in.Principal.ID, Email: in.Principal.Email, Name: in.Principal.Name}
	resolved, err := resolveGrantPrincipal(c, h.deps.repository, h.deps.googleGroupDirectory, h.deps.googleGroupsEnabled, in.Address, principal)
	if err != nil {
		respondGrantPrincipalError(c, err, in.Principal.Type)
		return
	}
	if !h.requireCanonicalOwnerForOwnerGroupChange(c, "folder", c.Param("id"), repo.Grant{}, repo.Grant{Principal: resolved, Role: in.Role}) {
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
	if !h.needFolderRole(c, c.Param("id"), repo.RoleCommenter) {
		return
	}
	var in struct {
		Role repo.Role `json:"role"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid grant")
		return
	}
	existing, err := h.deps.repository.GetGrant(c.Request.Context(), c.Param("id"), c.Param("grant_id"))
	if err != nil {
		notFound(c)
		return
	}
	if !validGrantRoleForPrincipal(existing.Principal.Type, in.Role) {
		badRequest(c, "invalid grant")
		return
	}
	if !h.requireCanonicalOwnerForOwnerGroupChange(c, "folder", c.Param("id"), existing, repo.Grant{Principal: existing.Principal, Role: in.Role}) {
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
	c.JSON(http.StatusOK, g)
}
func (h handlers) deleteFolderGrant(c *gin.Context) {
	if !h.needFolderRole(c, c.Param("id"), repo.RoleCommenter) {
		return
	}
	existing, err := h.deps.repository.GetGrant(c.Request.Context(), c.Param("id"), c.Param("grant_id"))
	if err != nil {
		notFound(c)
		return
	}
	if !h.requireCanonicalOwnerForOwnerGroupChange(c, "folder", c.Param("id"), existing, repo.Grant{}) {
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
	c.Status(http.StatusNoContent)
}
