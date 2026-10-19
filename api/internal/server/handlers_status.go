package server

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// SetDocumentStatus godoc
// @Summary Set document status
// @Description Sets the review status to draft, in_review, approved, or archived. An empty status clears it.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} map[string]string
// @Router /v1/documents/{id}/status [put]
func (h handlers) setDocumentStatus(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	if !requireJSON(c) {
		return
	}
	var body struct {
		Status *string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Status == nil {
		badRequest(c, "status is required")
		return
	}
	status := strings.TrimSpace(*body.Status)
	if status != "" && !slices.Contains(repo.DocumentStatuses, status) {
		badRequest(c, "status must be draft, in_review, approved, archived, or empty")
		return
	}
	if err := h.deps.repository.SetDocumentStatus(c.Request.Context(), c.Param("id"), status); err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": status})
}

// hydrateDocuments fills in each document's status, and its labels when
// labels are enabled. Both are decorative, so lookup failures leave them empty.
func (h handlers) hydrateDocuments(ctx context.Context, docs []*repo.Document) {
	if len(docs) == 0 {
		return
	}
	ids := make([]string, len(docs))
	for i, d := range docs {
		ids[i] = d.ID
	}
	if statuses, err := h.deps.repository.DocumentStatuses(ctx, ids); err == nil {
		for _, d := range docs {
			d.Status = statuses[d.ID]
		}
	}
	if h.deps.labelsEnabled {
		for _, d := range docs {
			if d.Labels == nil {
				d.Labels, _ = h.deps.repository.ListDocumentLabels(ctx, d.ID)
			}
		}
	}
}

func documentPointers(docs []repo.Document) []*repo.Document {
	out := make([]*repo.Document, len(docs))
	for i := range docs {
		out[i] = &docs[i]
	}
	return out
}

func entryDocuments(entries []repo.FolderEntry) []*repo.Document {
	out := make([]*repo.Document, 0, len(entries))
	for i := range entries {
		if entries[i].Document != nil {
			out = append(out, entries[i].Document)
		}
	}
	return out
}
