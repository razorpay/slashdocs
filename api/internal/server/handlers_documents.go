package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// createDocumentResponse is the payload of POST /v1/documents.
type createDocumentResponse struct {
	ID               string        `json:"id"`
	CurrentVersionID string        `json:"current_version_id"`
	DefaultGrant     *defaultGrant `json:"default_grant,omitempty"`
}

// defaultGrant reports the server-applied default "anyone" grant so clients
// can explain the exposure to their users and revoke it by id.
type defaultGrant struct {
	GrantID   string                `json:"grant_id"`
	Principal defaultGrantPrincipal `json:"principal"`
	Role      repo.Role             `json:"role"`
}

type defaultGrantPrincipal struct {
	Type auth.PrincipalType `json:"type"`
}

// CreateDocument godoc
// @Summary Create document
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Accept multipart/form-data
// @Produce json
// @Param title formData string true "Document title"
// @Param file formData file true "Single-file HTML"
// @Param default_permission formData string false "Default sharing applied at create: viewer, commenter, editor or private. Overrides the server-wide default."
// @Success 201 {object} createDocumentResponse
// @Router /v1/documents [post]
func (h handlers) createDocument(c *gin.Context) {
	p := current(c)
	html, err := readMultipartFile(c, "file")
	if errors.Is(err, errPayloadTooLarge) {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "HTML file exceeds 50 MiB", nil))
		return
	}
	if err != nil {
		badRequest(c, "invalid document upload")
		return
	}
	title := c.PostForm("title")
	// The request override beats the server-wide default regardless of
	// deployment mode: only the server env is org-gated (at startup), because
	// a caller who sets the field makes an explicit per-document choice.
	permission := h.deps.defaultDocPermission
	if raw, ok := c.GetPostForm("default_permission"); ok {
		role, valid := ParseDefaultDocPermission(raw)
		if !valid {
			badRequest(c, "default_permission must be viewer, commenter, editor or private")
			return
		}
		permission = role
	}
	if title == "" {
		badRequest(c, "invalid document upload")
		return
	}
	observeHTML("document_create", len(html))
	d, _, err := h.deps.repository.CreateDocument(c.Request.Context(), *p, title, html)
	if err != nil {
		if errors.Is(err, blob.ErrStorage) {
			c.JSON(http.StatusBadGateway, errorResponse("blob_storage_failed", "could not upload HTML to blob storage", nil))
			return
		}
		internalErr(c, err)
		return
	}
	incDocument("created", actorType(c))
	incVersion("created_initial", actorType(c))
	var granted *defaultGrant
	if permission != repo.RoleNone {
		g, err := h.deps.repository.CreateGrant(c.Request.Context(), "document", d.ID, auth.Principal{Type: auth.PrincipalAnyone}, permission, *p)
		if err != nil {
			// Rare storage fault. The document already exists at this point;
			// erroring beats returning a document that is silently less shared
			// than the effective default promised. Name the orphan so an
			// operator can find it and a retrying client's duplicate is
			// explainable.
			internalErr(c, fmt.Errorf("default grant for created document %s: %w", d.ID, err))
			return
		}
		incGrant("created", string(g.Role), string(g.Principal.Type), actorType(c))
		granted = &defaultGrant{GrantID: g.ID, Principal: defaultGrantPrincipal{Type: auth.PrincipalAnyone}, Role: g.Role}
	}
	c.JSON(http.StatusCreated, createDocumentResponse{ID: d.ID, CurrentVersionID: d.CurrentVersionID, DefaultGrant: granted})
}

// ListDocuments godoc
// @Summary List documents
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Produce json
// @Param q query string false "Slack-style search of titles and text: words, \"phrases\", -word, from:, in:, label:, before:, after:, on:, and during:"
// @Param tz query string false "IANA time zone for date modifiers; defaults to UTC"
// @Param label query string false "Deprecated exact label filter; use q=label:<label>"
// @Success 200 {object} listResponse[repo.Document]
// @Router /v1/documents [get]
func (h handlers) listDocuments(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	q := strings.TrimSpace(c.Query("q"))
	zone, err := time.LoadLocation(c.Query("tz"))
	if err != nil {
		badRequest(c, "invalid tz")
		return
	}
	search, err := parseDocumentSearch(q, *current(c), time.Now().In(zone))
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	search.IncludeLabels = h.deps.labelsEnabled
	if label := strings.ToLower(strings.TrimSpace(c.Query("label"))); label != "" {
		if !h.deps.labelsEnabled {
			featureDisabled(c, "Document labels are temporarily disabled")
			return
		}
		if !labelPattern.MatchString(label) {
			badRequest(c, "invalid label")
			return
		}
		search.Labels = append(search.Labels, label)
	}
	if q != "" || len(search.Labels) > 0 {
		includeOrgWide := h.deps.deployment == DeploymentOrg
		items, err := h.deps.repository.SearchDocuments(c.Request.Context(), *current(c), search, includeOrgWide, 25)
		if err != nil {
			internalErr(c, err)
			return
		}
		h.hydrateDocuments(c.Request.Context(), documentPointers(items))
		c.JSON(http.StatusOK, listResponse[repo.Document]{Items: items})
		return
	}
	items, err := h.deps.repository.ListDocuments(c.Request.Context(), *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	h.hydrateDocuments(c.Request.Context(), documentPointers(items))
	c.JSON(http.StatusOK, listResponse[repo.Document]{Items: items})
}

// GetDocument godoc
// @Summary Get document
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} repo.Document
// @Router /v1/documents/{id} [get]
func (h handlers) getDocument(c *gin.Context) {
	d, err := h.deps.repository.GetDocument(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	role, err := h.deps.repository.RoleForDocument(c.Request.Context(), *current(c), d.ID)
	if err != nil {
		internalErr(c, err)
		return
	}
	if !atLeast(role, repo.RoleViewer) {
		denyDocRole(c, repo.RoleViewer)
		return
	}
	p := current(c)
	// The workspace lists documents that a signed-in principal opened.
	if p.Type != auth.PrincipalAnonymous && (p.Type != d.Owner.Type || p.ID != d.Owner.ID) {
		_ = h.deps.repository.RecordDocumentOpened(c.Request.Context(), d.ID, *p)
	}
	// Show parent folder in breadcrumb only if viewer has access to it. The
	// breadcrumb is decorative, so a failed role lookup omits it rather than
	// failing the whole request.
	if d.ParentFolderID != "" {
		if r, err := h.deps.repository.RoleForFolder(c.Request.Context(), *p, d.ParentFolderID); err == nil && atLeast(r, repo.RoleViewer) {
			f, err := h.deps.repository.GetFolder(c.Request.Context(), d.ParentFolderID)
			if err == nil {
				d.ParentFolder = &repo.FolderBreadcrumb{ID: f.ID, Title: f.Title}
			}
		}
	}
	h.hydrateDocuments(c.Request.Context(), []*repo.Document{&d})
	c.JSON(http.StatusOK, d)
}

// PatchDocument godoc
// @Summary Update document
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} repo.Document
// @Router /v1/documents/{id} [patch]
func (h handlers) patchDocument(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleOwner) {
		return
	}
	var in struct{ Title string }
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid body")
		return
	}
	if in.Title == "" {
		badRequest(c, "nothing to update; provide a title")
		return
	}
	d, err := h.deps.repository.UpdateDocument(c.Request.Context(), c.Param("id"), in.Title)
	if err != nil {
		internalErr(c, err)
		return
	}
	h.announce(c, repo.DocumentEventDocument)
	c.JSON(http.StatusOK, d)
}

// DeleteDocument godoc
// @Summary Delete document
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 204
// @Router /v1/documents/{id} [delete]
func (h handlers) deleteDocument(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleOwner) {
		return
	}
	if err := h.deps.repository.DeleteDocument(c.Request.Context(), c.Param("id")); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
