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
// @Description Records the request for the people who manage access, and notifies the current owner when notifications are enabled. The response does not reveal whether the document or owner exists. Repeated requests are coalesced.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 202 {object} map[string]string
// @Router /v1/documents/{id}/access-requests [post]
func (h handlers) requestDocumentAccess(c *gin.Context) {
	if err := h.deps.repository.RequestDocumentAccess(c.Request.Context(), *current(c), c.Param("id")); err != nil {
		internalErr(c, err)
		return
	}
	// Keep the same response for missing, already-accessible, and recently
	// requested documents so this endpoint cannot be used for enumeration.
	c.JSON(http.StatusAccepted, gin.H{"status": "sent"})
}

// listDocumentAccessRequests godoc
// @Summary List requests for access to a document
// @Description The newest first. A grant on the document to the requester removes the request.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} listResponse[repo.AccessRequest]
// @Router /v1/documents/{id}/access-requests [get]
func (h handlers) listDocumentAccessRequests(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	items, err := h.deps.repository.ListAccessRequests(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.AccessRequest]{Items: items})
}
