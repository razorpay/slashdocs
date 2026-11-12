package server

import (
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

var labelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,47}$`)

func (h handlers) listDocumentLabels(c *gin.Context) {
	if !h.deps.labelsEnabled {
		featureDisabled(c, "Document labels are temporarily disabled")
		return
	}
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	labels, err := h.deps.repository.ListDocumentLabels(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": labels})
}

func (h handlers) replaceDocumentLabels(c *gin.Context) {
	if !h.deps.labelsEnabled {
		featureDisabled(c, "Document labels are temporarily disabled")
		return
	}
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	var body struct {
		Labels []string `json:"labels"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		badRequest(c, "labels are required")
		return
	}
	if len(body.Labels) > 20 {
		badRequest(c, "at most 20 labels are allowed")
		return
	}
	seen := map[string]bool{}
	labels := make([]string, 0, len(body.Labels))
	for _, raw := range body.Labels {
		label := strings.ToLower(strings.TrimSpace(raw))
		if !labelPattern.MatchString(label) {
			badRequest(c, "labels must use lowercase letters, numbers, dots, underscores, or hyphens")
			return
		}
		if !seen[label] {
			seen[label] = true
			labels = append(labels, label)
		}
	}
	sort.Strings(labels)
	labels, err := h.deps.repository.ReplaceDocumentLabels(c.Request.Context(), c.Param("id"), labels, *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": labels})
}
