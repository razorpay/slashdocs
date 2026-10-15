package server

import (
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

var (
	labelPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,47}$`)
	errTooManyLabels = errors.New("at most 20 labels are allowed")
	errInvalidLabel  = errors.New("labels must use lowercase letters, numbers, dots, underscores, or hyphens")
)

func validateAndNormalizeLabels(rawLabels []string) ([]string, error) {
	if len(rawLabels) > 20 {
		return nil, errTooManyLabels
	}
	seen := map[string]bool{}
	labels := make([]string, 0, len(rawLabels))
	for _, raw := range rawLabels {
		label := strings.ToLower(strings.TrimSpace(raw))
		if !labelPattern.MatchString(label) {
			return nil, errInvalidLabel
		}
		if !seen[label] {
			seen[label] = true
			labels = append(labels, label)
		}
	}
	sort.Strings(labels)
	return labels, nil
}

func parseFormLabels(c *gin.Context) []string {
	var result []string
	for _, item := range c.PostFormArray("labels") {
		for _, part := range strings.Split(item, ",") {
			trimmed := strings.TrimSpace(part)
			if trimmed != "" {
				result = append(result, trimmed)
			}
		}
	}
	return result
}

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
	labels, err := validateAndNormalizeLabels(body.Labels)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	labels, err = h.deps.repository.ReplaceDocumentLabels(c.Request.Context(), c.Param("id"), labels, *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": labels})
}
