package server

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// notificationPreferences godoc
// @Summary Read your notification preferences
// @Tags notifications
// @Security bearerAuth
// @Security cookieAuth
// @Success 200 {object} repo.NotificationPreferences
// @Router /v1/me/notifications [get]
func (h handlers) notificationPreferences(c *gin.Context) {
	docID := c.Param("id")
	if docID != "" && !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	prefs, err := h.deps.repository.NotificationPreferences(c.Request.Context(), *current(c), docID)
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, prefs)
}

type notificationPreferencesRequest struct {
	Enabled *bool `json:"enabled"`
}

// setNotificationPreferences godoc
// @Summary Set your notification preferences
// @Description Applies only to the authenticated principal. Document preferences never change access or other users' notifications. Global disable overrides document preferences.
// @Tags notifications
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param body body notificationPreferencesRequest true "Notification preference"
// @Success 200 {object} repo.NotificationPreferences
// @Router /v1/me/notifications [put]
func (h handlers) setNotificationPreferences(c *gin.Context) {
	docID := c.Param("id")
	if docID != "" && !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
	var in notificationPreferencesRequest
	if err := c.ShouldBindJSON(&in); err != nil || in.Enabled == nil {
		badRequest(c, "enabled must be a boolean")
		return
	}
	prefs, err := h.deps.repository.SetNotificationPreferences(c.Request.Context(), *current(c), docID, *in.Enabled)
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, prefs)
}

// documentNotificationPreferences godoc
// @Summary Read your notification preferences for a document
// @Tags notifications
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} repo.NotificationPreferences
// @Router /v1/documents/{id}/notifications [get]
func (h handlers) documentNotificationPreferences(c *gin.Context) { h.notificationPreferences(c) }

// setDocumentNotificationPreferences godoc
// @Summary Enable or mute your document notifications
// @Description Personal preference only. Global disable overrides this preference.
// @Tags notifications
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Document ID"
// @Param body body notificationPreferencesRequest true "Notification preference"
// @Success 200 {object} repo.NotificationPreferences
// @Router /v1/documents/{id}/notifications [put]
func (h handlers) setDocumentNotificationPreferences(c *gin.Context) { h.setNotificationPreferences(c) }

// requestDocumentAccess godoc
// @Summary Request access to a document
// @Description Persists a request to the owner. Repeated requests are coalesced. Enumeration-safe: returns the same body for missing, already-accessible, or recently-requested documents.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 202 {object} map[string]string
// @Router /v1/documents/{id}/access-requests [post]
func (h handlers) requestDocumentAccess(c *gin.Context) {
	result, err := h.deps.repository.RequestDocumentAccess(c.Request.Context(), *current(c), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	// Keep the same response shape for missing, already-accessible, and recently
	// requested documents so this endpoint cannot be used for enumeration.
	// Status is "notified" when a Slack/email was queued, "recorded" otherwise.
	c.JSON(http.StatusAccepted, gin.H{"status": result.Status})
}

// listDocumentAccessRequests godoc
// @Summary List pending access requests for a document
// @Description Returns up to 100 requests ordered by requested_at descending. Pass next_page_token as the "after" query parameter to retrieve the next page.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param after query string false "RFC3339 cursor — last requested_at from the previous page"
// @Success 200 {object} map[string]any
// @Router /v1/documents/{id}/access-requests [get]
func (h handlers) listDocumentAccessRequests(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleOwner) {
		return
	}
	after := c.Query("after")
	requests, err := h.deps.repository.ListAccessRequests(c.Request.Context(), c.Param("id"), after)
	if err != nil {
		internalErr(c, err)
		return
	}
	var nextPageToken string
	if len(requests) == 100 {
		nextPageToken = requests[len(requests)-1].RequestedAt
	}
	c.JSON(http.StatusOK, gin.H{"items": requests, "next_page_token": nextPageToken})
}
