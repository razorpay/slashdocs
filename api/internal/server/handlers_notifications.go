package server

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
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
// @Description The newest first. People who manage access see every request. Other callers see only their own request, so that they know it waits. A grant on the document to the requester removes the request.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} listResponse[repo.AccessRequest]
// @Router /v1/documents/{id}/access-requests [get]
func (h handlers) listDocumentAccessRequests(c *gin.Context) {
	ctx, p := c.Request.Context(), current(c)
	role, err := h.deps.repository.RoleForDocument(ctx, *p, c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	var only *auth.Principal
	if !atLeast(role, repo.RoleEditor) {
		only = p
	}
	items, err := h.deps.repository.ListAccessRequests(ctx, c.Param("id"), only)
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.AccessRequest]{Items: items})
}

// listManagedAccessRequests godoc
// @Summary List requests for access to the documents that the caller manages
// @Description The newest first, across every document on which the caller manages access. Each request names its document.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Success 200 {object} listResponse[repo.DocumentAccessRequest]
// @Router /v1/access-requests [get]
func (h handlers) listManagedAccessRequests(c *gin.Context) {
	items, err := h.deps.repository.ListManagedAccessRequests(c.Request.Context(), *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.DocumentAccessRequest]{Items: items})
}

// declineDocumentAccessRequest godoc
// @Summary Decline a request for access to a document
// @Description Removes the request without a grant. The requester can ask again.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param requester_type path string true "Requester type" Enums(user, service_account)
// @Param requester_id path string true "Requester ID"
// @Success 204
// @Router /v1/documents/{id}/access-requests/{requester_type}/{requester_id} [delete]
func (h handlers) declineDocumentAccessRequest(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	requester := auth.Principal{Type: auth.PrincipalType(c.Param("requester_type")), ID: c.Param("requester_id")}
	if requester.Type != auth.PrincipalUser && requester.Type != auth.PrincipalServiceAccount {
		badRequest(c, "requester_type must be user or service_account")
		return
	}
	if err := h.deps.repository.DeclineAccessRequest(c.Request.Context(), c.Param("id"), requester); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// inbox godoc
// @Summary List what waits on the caller
// @Description The newest first, at most 50: each document that the caller approves and did not decide on (kind approval), and each open thread on a document of the caller, that they wrote in, or that mentions them, with a message by someone else after their last read or message (kind thread). It holds only documents that the caller can read now.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Success 200 {object} listResponse[repo.InboxItem]
// @Router /v1/me/inbox [get]
func (h handlers) inbox(c *gin.Context) {
	ctx, p := c.Request.Context(), *current(c)
	// A principal can lose access after an approval request or a message,
	// so the inbox keeps only documents that they can read now, and reads
	// more pages until it has a page of them.
	readable := map[string]bool{}
	kept := []repo.InboxItem{}
	for offset := 0; len(kept) < repo.InboxPage; offset += repo.InboxPage {
		items, err := h.deps.repository.Inbox(ctx, p, offset)
		if err != nil {
			internalErr(c, err)
			return
		}
		for _, item := range items {
			ok, known := readable[item.DocumentID]
			if !known {
				role, err := h.deps.repository.RoleForDocument(ctx, p, item.DocumentID)
				if err != nil {
					internalErr(c, err)
					return
				}
				ok = atLeast(role, repo.RoleViewer)
				readable[item.DocumentID] = ok
			}
			if ok && len(kept) < repo.InboxPage {
				kept = append(kept, item)
			}
		}
		if len(items) < repo.InboxPage {
			break
		}
	}
	c.JSON(http.StatusOK, listResponse[repo.InboxItem]{Items: kept})
}
