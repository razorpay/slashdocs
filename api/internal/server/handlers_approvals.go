package server

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// approvalRequestResponse is one assigned approver in API responses.
type approvalRequestResponse struct {
	ID          string            `json:"id"`
	DocumentID  string            `json:"document_id"`
	Approver    principalResponse `json:"approver"`
	RequestedBy requestedByJSON   `json:"requested_by"`
}

// requestedByJSON is the trimmed requester reference (mirrors grants'
// granted_by shape).
type requestedByJSON struct {
	ID    string `json:"id"`
	Email string `json:"email,omitempty"`
}

func approvalRequestJSON(r repo.ApprovalRequest) approvalRequestResponse {
	return approvalRequestResponse{
		ID:          r.ID,
		DocumentID:  r.DocumentID,
		Approver:    principalJSON(r.Approver),
		RequestedBy: requestedByJSON{ID: r.RequestedBy.ID, Email: r.RequestedBy.Email},
	}
}

// maxApprovalNote bounds the reviewer note so a decision stays a short
// explanation rather than a document of its own.
const maxApprovalNote = 2000

// approvalResponse is one decision in API responses.
type approvalResponse struct {
	ID         string `json:"id"`
	DocumentID string `json:"document_id"`
	VersionID  string `json:"version_id"`
	// VersionNumber and VersionSHA256 name the exact content the decision was
	// made on.
	VersionNumber        int               `json:"version_number,omitempty"`
	VersionSHA256        string            `json:"version_sha256,omitempty"`
	Approver             principalResponse `json:"approver"`
	Decision             string            `json:"decision"`
	Note                 string            `json:"note,omitempty"`
	DecidedAt            string            `json:"decided_at,omitempty"`
	CarriedFromVersionID string            `json:"carried_from_version_id,omitempty"`
}

func approvalJSON(a repo.Approval) approvalResponse {
	return approvalResponse{
		ID:                   a.ID,
		DocumentID:           a.DocumentID,
		VersionID:            a.VersionID,
		Approver:             principalJSON(a.Approver),
		Decision:             a.Decision,
		Note:                 a.Note,
		DecidedAt:            a.DecidedAt,
		CarriedFromVersionID: a.CarriedFromVersionID,
	}
}

// approvalListItem merges an assigned approver with their decision on the
// requested version; Decision is null while they are pending.
type approvalListItem struct {
	ID                   string            `json:"id,omitempty"`
	Approver             principalResponse `json:"approver"`
	Decision             *string           `json:"decision"`
	Note                 string            `json:"note,omitempty"`
	DecidedAt            string            `json:"decided_at,omitempty"`
	CarriedFromVersionID string            `json:"carried_from_version_id,omitempty"`
	// CarriedFromVersionNumber is the display number of the version that
	// received the explicit decision, so the UI can say "Approved on v3"
	// instead of an opaque ID. Zero when the decision is not carried.
	CarriedFromVersionNumber int `json:"carried_from_version_number,omitempty"`
	// CreatedVersion is true when the approver created a version of this
	// document. They cannot decide on it, so the document waits for the owner
	// to replace them.
	CreatedVersion bool `json:"created_version,omitempty"`
}

// approvalsListResponse is the payload of GET /v1/documents/{id}/approvals.
type approvalsListResponse struct {
	VersionID     string               `json:"version_id"`
	VersionNumber int                  `json:"version_number,omitempty"`
	VersionSHA256 string               `json:"version_sha256,omitempty"`
	Status        string               `json:"status,omitempty"`
	Summary       repo.ApprovalSummary `json:"summary"`
	Items         []approvalListItem   `json:"items"`
}

func validApprovalDecision(d string) bool {
	return d == repo.DecisionApproved || d == repo.DecisionChangesRequested
}

// Someone who created a version of a document wrote what is under review, so
// they cannot be the one who approves it (as an author cannot approve their own
// pull request).
const (
	errCreatedVersionApprover = "That person created a version of this document, so they can't approve it. Ask someone who hasn't worked on it."
	errCreatedVersionDecider  = "You created a version of this document, so you can't approve it. Ask someone who hasn't worked on it."
	errVersionSuperseded      = "A newer version of this document exists. Review the latest version before deciding."
)

func principalKey(p auth.Principal) string {
	return string(p.Type) + ":" + p.ID
}

// versionCreators returns the principals that created any version of the
// document, keyed by principalKey.
func (h handlers) versionCreators(ctx context.Context, documentID string) (map[string]bool, error) {
	versions, err := h.deps.repository.ListVersions(ctx, documentID)
	if err != nil {
		return nil, err
	}
	creators := make(map[string]bool, len(versions))
	for _, v := range versions {
		creators[principalKey(v.CreatedBy)] = true
	}
	return creators, nil
}

// CreateApprover godoc
// @Summary Assign an approver
// @Description Assigns a user or service account as an approver. The approver must already have at least viewer access on the document, and must not have created a version of it.
// @Tags approvals
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 201 {object} approvalRequestResponse
// @Router /v1/documents/{id}/approvers [post]
func (h handlers) createApprover(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleOwner) {
		return
	}
	p := current(c)
	var in struct {
		Address   string `json:"address"`
		Principal struct {
			Type  auth.PrincipalType `json:"type"`
			ID    string             `json:"id"`
			Email string             `json:"email"`
			Name  string             `json:"name"`
		} `json:"principal"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid approver")
		return
	}
	principal := auth.Principal{Type: in.Principal.Type, ID: in.Principal.ID, Email: in.Principal.Email, Name: in.Principal.Name}
	// Approvers are users or service accounts only; Google Groups are never
	// resolved here regardless of server configuration.
	resolved, err := resolveGrantPrincipal(c, h.deps.repository, nil, false, in.Address, principal)
	if err != nil {
		switch {
		case errors.Is(err, errInvalidAddress):
			badRequest(c, "That doesn't look like an email or bot address.")
		case errors.Is(err, errPrincipalIDRequired):
			badRequest(c, "principal id, user email, or service account name is required")
		case errors.Is(err, errUnknownUserEmail):
			badRequest(c, "No slashdocs user exists for that email. Ask them to sign in once, then try again.")
		case errors.Is(err, errGoogleGroupsDisabled), errors.Is(err, errGoogleGroupEmailRequired):
			badRequest(c, "approvers must be users or service accounts")
		case errors.Is(err, repo.ErrNotFound):
			notFound(c)
		default:
			internalErr(c, err)
		}
		return
	}
	if resolved.Type != auth.PrincipalUser && resolved.Type != auth.PrincipalServiceAccount {
		badRequest(c, "approvers must be users or service accounts")
		return
	}
	role, err := h.deps.repository.RoleForDocument(c.Request.Context(), resolved, c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	if !atLeast(role, repo.RoleViewer) {
		badRequest(c, "approver must have at least viewer access on this document")
		return
	}
	creators, err := h.versionCreators(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	if creators[principalKey(resolved)] {
		badRequest(c, errCreatedVersionApprover)
		return
	}
	req, err := h.deps.repository.CreateApprovalRequest(c.Request.Context(), c.Param("id"), resolved, *p)
	if errors.Is(err, repo.ErrConflict) {
		c.JSON(http.StatusConflict, errorResponse("conflict", "already an approver on this document", nil))
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	incApproval("approver_assigned", labelUnknown, actorType(c))
	c.JSON(http.StatusCreated, approvalRequestJSON(req))
}

// ListApprovers godoc
// @Summary List assigned approvers
// @Tags approvals
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} listResponse[approvalRequestResponse]
// @Router /v1/documents/{id}/approvers [get]
func (h handlers) listApprovers(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	requests, err := h.deps.repository.ListApprovalRequests(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	items := make([]approvalRequestResponse, 0, len(requests))
	for _, r := range requests {
		items = append(items, approvalRequestJSON(r))
	}
	c.JSON(http.StatusOK, listResponse[approvalRequestResponse]{Items: items})
}

// DeleteApprover godoc
// @Summary Remove an approver
// @Description Removes the assignment and revokes all of that approver's decisions on the document.
// @Tags approvals
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param approver_id path string true "Approval request ID"
// @Success 204
// @Router /v1/documents/{id}/approvers/{approver_id} [delete]
func (h handlers) deleteApprover(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleOwner) {
		return
	}
	err := h.deps.repository.DeleteApprovalRequest(c.Request.Context(), c.Param("id"), c.Param("approver_id"))
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	incApproval("approver_removed", labelUnknown, actorType(c))
	c.Status(http.StatusNoContent)
}

// CreateApproval godoc
// @Summary Submit or update a decision
// @Description Records the caller's decision on the latest version. Submitting again replaces the previous decision for that version. Returns 403 when the caller created a version of the document (nobody approves their own work) and 409 when a newer version exists.
// @Tags approvals
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 201 {object} approvalResponse
// @Success 200 {object} approvalResponse
// @Router /v1/documents/{id}/approvals [post]
func (h handlers) createApproval(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	p := current(c)
	var in struct {
		VersionID string `json:"version_id"`
		Decision  string `json:"decision"`
		Note      string `json:"note"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid approval")
		return
	}
	if in.VersionID == "" {
		badRequest(c, "version_id is required")
		return
	}
	if !validApprovalDecision(in.Decision) {
		badRequest(c, `decision must be "approved" or "changes_requested"`)
		return
	}
	note := strings.TrimSpace(in.Note)
	// Requesting changes without saying what to change leaves the author
	// guessing, so the note is mandatory for that decision only.
	if in.Decision == repo.DecisionChangesRequested && note == "" {
		badRequest(c, "note is required when requesting changes: say what needs to change")
		return
	}
	if len(note) > maxApprovalNote {
		badRequest(c, "note is too long")
		return
	}
	ctx := c.Request.Context()
	// An unknown or foreign version is a 404; a known one must also still be the
	// latest, or the decision would be about content that has been replaced and
	// would count for nothing.
	version, err := h.deps.repository.GetVersion(ctx, in.VersionID)
	if errors.Is(err, repo.ErrNotFound) || (err == nil && version.DocumentID != c.Param("id")) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	creators, err := h.versionCreators(ctx, c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	if creators[principalKey(*p)] {
		forbidden(c, errCreatedVersionDecider)
		return
	}
	d, err := h.deps.repository.GetDocument(ctx, c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	if d.CurrentVersionID != version.ID {
		c.JSON(http.StatusConflict, errorResponse("version_superseded", errVersionSuperseded, versionConflictDetails{CurrentVersionID: d.CurrentVersionID}))
		return
	}
	a, created, err := h.deps.repository.CreateOrUpdateApproval(ctx, c.Param("id"), in.VersionID, in.Decision, note, *p)
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	if errors.Is(err, repo.ErrForbidden) {
		forbidden(c, "not an assigned approver on this document")
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	incApproval("decided", a.Decision, actorType(c))
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	resp := approvalJSON(a)
	resp.VersionNumber = version.Number
	resp.VersionSHA256 = version.SHA256
	c.JSON(status, resp)
}

// ListApprovals godoc
// @Summary List decisions and aggregate status
// @Description Per-approver decisions for a version (current version by default), merged with pending approvers, plus the derived aggregate status.
// @Tags approvals
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version query string false "Version ID (defaults to the current version)"
// @Success 200 {object} approvalsListResponse
// @Router /v1/documents/{id}/approvals [get]
func (h handlers) listApprovals(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	versionID := c.Query("version")
	if versionID == "" {
		d, err := h.deps.repository.GetDocument(c.Request.Context(), c.Param("id"))
		if err != nil {
			internalErr(c, err)
			return
		}
		versionID = d.CurrentVersionID
	}
	// An unknown or foreign version would otherwise return 200 with an
	// invented all-pending state, so reject it outright.
	version, err := h.deps.repository.GetVersion(c.Request.Context(), versionID)
	if errors.Is(err, repo.ErrNotFound) || (err == nil && version.DocumentID != c.Param("id")) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	requests, err := h.deps.repository.ListApprovalRequests(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	decisions, err := h.deps.repository.ListApprovals(c.Request.Context(), c.Param("id"), versionID)
	if err != nil {
		internalErr(c, err)
		return
	}
	decisionByApprover := make(map[string]repo.Approval, len(decisions))
	for _, a := range decisions {
		decisionByApprover[string(a.Approver.Type)+":"+a.Approver.ID] = a
	}
	// Best-effort, like the carried version numbers: without it the list just
	// does not flag approvers who created a version.
	creators, err := h.versionCreators(c.Request.Context(), c.Param("id"))
	if err != nil {
		requestLogger(c).Warn("approval version creators", "error", err)
	}
	summary := repo.ApprovalSummary{Total: len(requests)}
	items := make([]approvalListItem, 0, len(requests))
	for _, r := range requests {
		item := approvalListItem{Approver: principalJSON(r.Approver), CreatedVersion: creators[principalKey(r.Approver)]}
		if a, ok := decisionByApprover[string(r.Approver.Type)+":"+r.Approver.ID]; ok {
			decision := a.Decision
			item.ID = a.ID
			item.Decision = &decision
			item.Note = a.Note
			item.DecidedAt = a.DecidedAt
			item.CarriedFromVersionID = a.CarriedFromVersionID
			switch a.Decision {
			case repo.DecisionApproved:
				summary.Approved++
			case repo.DecisionChangesRequested:
				summary.ChangesRequested++
			}
		}
		items = append(items, item)
	}
	h.annotateCarriedVersionNumbers(c, items)
	summary.Pending = summary.Total - summary.Approved - summary.ChangesRequested
	summary.Status = repo.DeriveApprovalStatus(summary.Total, summary.Approved, summary.ChangesRequested)
	c.JSON(http.StatusOK, approvalsListResponse{
		VersionID:     versionID,
		VersionNumber: version.Number,
		VersionSHA256: version.SHA256,
		Status:        summary.Status,
		Summary:       summary,
		Items:         items,
	})
}

// DeleteApproval godoc
// @Summary Revoke own decision
// @Description Removes the caller's decision on a version, returning them to pending. Assignment is unaffected.
// @Tags approvals
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param approval_id path string true "Approval ID"
// @Success 204
// @Router /v1/documents/{id}/approvals/{approval_id} [delete]
func (h handlers) deleteApproval(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	err := h.deps.repository.DeleteApproval(c.Request.Context(), c.Param("id"), c.Param("approval_id"), *current(c))
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	if errors.Is(err, repo.ErrForbidden) {
		forbidden(c, "you can only revoke your own decision")
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	incApproval("revoked", labelUnknown, actorType(c))
	c.Status(http.StatusNoContent)
}

// annotateCarriedVersionNumbers fills in the display number of each carried
// decision's origin version. Best-effort: a failed lookup leaves the numbers
// at zero and the UI falls back to a plain "carried forward" label.
func (h handlers) annotateCarriedVersionNumbers(c *gin.Context, items []approvalListItem) {
	needed := false
	for _, it := range items {
		if it.CarriedFromVersionID != "" {
			needed = true
			break
		}
	}
	if !needed {
		return
	}
	versions, err := h.deps.repository.ListVersions(c.Request.Context(), c.Param("id"))
	if err != nil {
		requestLogger(c).Warn("carried version numbers", "error", err)
		return
	}
	numberByID := make(map[string]int, len(versions))
	for _, v := range versions {
		numberByID[v.ID] = v.Number
	}
	for i := range items {
		if n, ok := numberByID[items[i].CarriedFromVersionID]; ok {
			items[i].CarriedFromVersionNumber = n
		}
	}
}

// annotateApprovalSummaries decorates documents with their approval status.
// Best-effort like the parent-folder breadcrumb: a failed lookup leaves the
// fields absent rather than failing the request.
func (h handlers) annotateApprovalSummaries(c *gin.Context, docs []repo.Document) {
	if len(docs) == 0 {
		return
	}
	ids := make([]string, 0, len(docs))
	for _, d := range docs {
		ids = append(ids, d.ID)
	}
	summaries, err := h.deps.repository.DocumentApprovalSummaries(c.Request.Context(), ids)
	if err != nil {
		requestLogger(c).Warn("approval summaries", "error", err)
		return
	}
	for i := range docs {
		if s, ok := summaries[docs[i].ID]; ok {
			summary := s
			docs[i].ApprovalStatus = s.Status
			docs[i].ApprovalSummary = &summary
		}
	}
}
