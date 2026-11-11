package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/render"
	"github.com/razorpay/slashdocs/internal/textedit"
)

// createVersionResponse is the payload of POST /v1/documents/{id}/versions.
type createVersionResponse struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	SHA256        string `json:"sha256"`
	ChangeSummary string `json:"change_summary,omitempty"`
	// BaseVersionID is the version that the new version saved on.
	BaseVersionID string `json:"base_version_id"`
	// Rebased is set when that version is newer than the base version of the
	// upload, so the new version also holds the changes of other writers.
	Rebased bool `json:"rebased"`
}

// versionConflictDetails names the latest version when a create hits a stale
// base_version_id.
type versionConflictDetails struct {
	CurrentVersionID string `json:"current_version_id"`
}

// editDocumentRequest is the body of POST /v1/documents/{id}/edits.
type editDocumentRequest struct {
	// BaseVersionID, when set, must be the current version. When it is
	// empty the edits apply to whatever version is current, which is safe
	// because each edit must still find its text there.
	BaseVersionID string          `json:"base_version_id,omitempty"`
	ChangeSummary string          `json:"change_summary,omitempty"`
	Edits         []textedit.Edit `json:"edits"`
}

// editDocumentResponse is the payload of POST /v1/documents/{id}/edits.
type editDocumentResponse struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	SHA256        string `json:"sha256"`
	ChangeSummary string `json:"change_summary,omitempty"`
	// BaseVersionID is the version the edits were applied to.
	BaseVersionID string `json:"base_version_id"`
	EditsApplied  int    `json:"edits_applied"`
}

// editFailedDetails names the edit that did not match and the version it was
// matched against.
type editFailedDetails struct {
	textedit.Error
	CurrentVersionID string `json:"current_version_id"`
}

// editRebaseAttempts bounds how often an edit without a base version, a
// source edit, or an upload on an earlier version retries when another write
// lands between reading and saving the current version.
const editRebaseAttempts = 3

// editSourceRequest is the body of POST /v1/documents/{id}/source-edits.
type editSourceRequest struct {
	// BaseVersionID is the version that the replacements were made on.
	BaseVersionID string `json:"base_version_id"`
	// ClientChangeID names the change, so that a retry returns the version
	// that the change made instead of a second one.
	ClientChangeID string `json:"client_change_id"`
	// ChangeSummary, when set, is what History shows for the change. When it
	// is empty, the server names what a reader sees change.
	ChangeSummary string                 `json:"change_summary,omitempty"`
	Replacements  []textedit.Replacement `json:"replacements"`
}

// editSourceResponse is the payload of POST /v1/documents/{id}/source-edits.
type editSourceResponse struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	SHA256        string `json:"sha256"`
	ChangeSummary string `json:"change_summary,omitempty"`
	// BaseVersionID is the version the replacements were applied to.
	BaseVersionID string `json:"base_version_id"`
	// Rebased is set when that version is newer than the version that the
	// replacements were made on.
	Rebased bool `json:"rebased"`
	// Others, set when rebased, turn the HTML that the caller holds, the
	// base version with its replacements, into the HTML of the new version:
	// the changes of the other writers. They are in order, at byte offsets
	// of the HTML that the caller holds.
	Others []textedit.Replacement `json:"others,omitempty"`
}

// replacementFailedDetails names the replacement that does not fit its base
// version, and the current version.
type replacementFailedDetails struct {
	textedit.ReplacementError
	CurrentVersionID string `json:"current_version_id"`
}

// documentChangesResponse is the payload of GET /v1/documents/{id}/changes.
type documentChangesResponse struct {
	// VersionID is the current version.
	VersionID     string `json:"version_id"`
	FromVersionID string `json:"from_version_id"`
	// Replacements turn the HTML of the version from into the HTML of the
	// current version. They are in order, at byte offsets of the version from.
	Replacements []textedit.Replacement `json:"replacements"`
	// Live is set when the browser editor made every version after from.
	Live bool `json:"live"`
	// Authors made the versions after from. The author of the newest version
	// comes first.
	Authors []auth.Principal `json:"authors"`
}

// maxClientChangeIDBytes caps the client_change_id of a source edit.
const maxClientChangeIDBytes = 128

// renderTokenResponse is the payload of POST .../render-token.
type renderTokenResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
}

// CreateVersion godoc
// @Summary Create version
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept multipart/form-data
// @Param id path string true "Document ID"
// @Param base_version_id formData string true "Base version ID"
// @Param change_summary formData string false "Change summary"
// @Description Saves the uploaded HTML as a new version. When base_version_id is an earlier version of the document, the changes from that version to the upload move onto the current version, and the response has rebased set. When the current version changed the same HTML, the response is version_conflict.
// @Param file formData file true "HTML file"
// @Success 201 {object} createVersionResponse
// @Failure 409 {object} errorEnvelope
// @Failure 413 {object} errorEnvelope
// @Router /v1/documents/{id}/versions [post]
func (h handlers) createVersion(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	p := current(c)
	html, err := readMultipartFile(c, "file")
	if errors.Is(err, errPayloadTooLarge) {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "HTML file exceeds 50 MiB", nil))
		return
	}
	if err != nil {
		badRequest(c, "file is required")
		return
	}
	observeHTML("version_create", len(html))
	ctx, docID, base := c.Request.Context(), c.Param("id"), c.PostForm("base_version_id")
	summary := strings.TrimSpace(c.PostForm("change_summary"))
	if summary == "" {
		if summary, err = h.uploadedSummary(ctx, docID, base, html); err != nil {
			internalErr(c, err)
			return
		}
	}
	v, onto, err := h.saveUpload(ctx, docID, base, summary, html, *p)
	if err != nil {
		h.editFailed(c, err, true)
		return
	}
	incVersion("created", actorType(c))
	h.announceVersion(c, v.ID)
	c.JSON(http.StatusCreated, createVersionResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary, BaseVersionID: onto, Rebased: onto != base})
}

// saveUpload saves html, which the caller made from the version base, as the
// next version. It returns the new version and the version that it saved on.
// When base is an earlier version of the document, the changes from base to
// html move onto the current version. The base stays stale when the current
// version changed the same HTML, when html changes nothing, and when base is
// not a version of the document.
func (h handlers) saveUpload(ctx context.Context, docID, base, summary string, html []byte, author auth.Principal) (repo.Version, string, error) {
	r := h.deps.repository
	v, err := r.CreateVersion(ctx, docID, base, "", summary, html, author)
	var stale *repo.VersionConflictError
	if !errors.As(err, &stale) {
		return v, base, err
	}
	if _, err := h.versionOf(ctx, docID, base); errors.Is(err, repo.ErrNotFound) {
		return repo.Version{}, "", stale
	} else if err != nil {
		return repo.Version{}, "", err
	}
	old, err := r.GetVersionHTML(ctx, base)
	if err != nil {
		return repo.Version{}, "", err
	}
	changes := textedit.Between(old, html)
	for attempt := 1; ; attempt++ {
		onto := stale.LatestVersionID
		latest, err := r.GetVersionHTML(ctx, onto)
		if err != nil {
			return repo.Version{}, "", err
		}
		rebased, err := textedit.Replace(old, latest, changes)
		if err != nil {
			return repo.Version{}, "", stale
		}
		// Another write can land after the read. The changes then move onto
		// that version.
		v, err := h.saveEdited(ctx, docID, onto, "", summary, rebased, author)
		if !errors.As(err, &stale) || attempt == editRebaseAttempts {
			return v, onto, err
		}
	}
}

// versionOf returns the version id of the document docID. A version of
// another document is not found, so that no caller reads its HTML.
func (h handlers) versionOf(ctx context.Context, docID, id string) (repo.Version, error) {
	v, err := h.deps.repository.GetVersion(ctx, id)
	if err == nil && v.DocumentID != docID {
		err = repo.ErrNotFound
	}
	return v, err
}

// uploadedSummary names an upload without a change summary, by what a reader
// sees change first from base, the version that it was made from. A base that
// is not a version of the document gets no summary: the save then reports it
// as stale.
func (h handlers) uploadedSummary(ctx context.Context, docID, base string, html []byte) (string, error) {
	r := h.deps.repository
	if _, err := h.versionOf(ctx, docID, base); errors.Is(err, repo.ErrNotFound) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	old, err := r.GetVersionHTML(ctx, base)
	if err != nil {
		return "", err
	}
	return "Uploaded a new version. " + textedit.ChangeSummary(old, html), nil
}

// EditDocument godoc
// @Summary Edit document text
// @Description Applies exact find-and-replace edits to the document HTML on the server and saves the result as a new version. Each old_string must occur exactly once; edits apply in order and either all apply or none do. The HTML is never parsed, so everything else stays byte-for-byte the same.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Document ID"
// @Param body body editDocumentRequest true "Edits"
// @Success 201 {object} editDocumentResponse
// @Failure 409 {object} errorEnvelope
// @Failure 422 {object} errorEnvelope
// @Router /v1/documents/{id}/edits [post]
func (h handlers) editDocument(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleEditor) {
		return
	}
	var in editDocumentRequest
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid edit request")
		return
	}
	if len(in.Edits) == 0 || len(in.Edits) > textedit.MaxEdits {
		badRequest(c, fmt.Sprintf("pass between 1 and %d edits", textedit.MaxEdits))
		return
	}
	for attempt := 1; ; attempt++ {
		v, base, err := h.saveEdits(c.Request.Context(), docID, in, *current(c))
		// Another write landed after the read. Without a base version the
		// edits are matched again against the new current version.
		if errors.Is(err, repo.ErrVersionConflict) && in.BaseVersionID == "" && attempt < editRebaseAttempts {
			continue
		}
		if err != nil {
			h.editFailed(c, err, in.BaseVersionID != "")
			return
		}
		incVersion("edited", actorType(c))
		h.announceVersion(c, v.ID)
		c.JSON(http.StatusCreated, editDocumentResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary, BaseVersionID: base, EditsApplied: len(in.Edits)})
		return
	}
}

// editMismatchError is an edit or replacement that did not fit the current
// version, versionID.
type editMismatchError struct {
	err       error
	versionID string
}

func (e *editMismatchError) Error() string { return e.err.Error() }
func (e *editMismatchError) Unwrap() error { return e.err }

var errEditedTooLarge = errors.New("edited HTML exceeds 50 MiB")

// saveEdits applies the edits to the current version and saves the result
// as the next one. It returns the new version and the version it edited.
func (h handlers) saveEdits(ctx context.Context, docID string, in editDocumentRequest, author auth.Principal) (repo.Version, string, error) {
	d, err := h.deps.repository.GetDocument(ctx, docID)
	if err != nil {
		return repo.Version{}, "", err
	}
	base := d.CurrentVersionID
	// Check a given base before reading anything, so the edits are only ever
	// matched against this document.
	if in.BaseVersionID != "" && in.BaseVersionID != base {
		return repo.Version{}, "", &repo.VersionConflictError{LatestVersionID: base}
	}
	html, err := h.deps.repository.GetVersionHTML(ctx, base)
	if err != nil {
		return repo.Version{}, "", err
	}
	edited, err := textedit.Apply(html, in.Edits)
	if err != nil {
		return repo.Version{}, "", &editMismatchError{err: err, versionID: base}
	}
	summary := strings.TrimSpace(in.ChangeSummary)
	if summary == "" {
		summary = textedit.Summary(in.Edits)
	}
	v, err := h.saveEdited(ctx, docID, base, "", summary, edited, author)
	return v, base, err
}

// saveEdited saves html, the edited content of the version base, as the next
// version.
func (h handlers) saveEdited(ctx context.Context, docID, base, clientChangeID, summary string, html []byte, author auth.Principal) (repo.Version, error) {
	if len(html) > maxHTMLBytes {
		return repo.Version{}, errEditedTooLarge
	}
	observeHTML("version_edit", len(html))
	return h.deps.repository.CreateVersion(ctx, docID, base, clientChangeID, summary, html, author)
}

// EditSource godoc
// @Summary Edit document source by position
// @Description For the browser editor. Applies replacements by position in the HTML of base_version_id to the current version, and saves the result as a new version. start and end count UTF-8 bytes, end is exclusive, and old_html must be the HTML from start to end of the base version. Replacements are in order and do not overlap. When a newer version exists, the replacements merge with its changes and the response has rebased set: text that both insert at one point stays twice, and text that either deletes goes. A retry with the same client_change_id returns the version that the first attempt made.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Document ID"
// @Param body body editSourceRequest true "Replacements"
// @Success 201 {object} editSourceResponse
// @Failure 400 {object} errorEnvelope
// @Failure 404 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope
// @Failure 413 {object} errorEnvelope
// @Failure 422 {object} errorEnvelope
// @Router /v1/documents/{id}/source-edits [post]
func (h handlers) editSource(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleEditor) {
		return
	}
	var in editSourceRequest
	if err := c.ShouldBindJSON(&in); err != nil || in.BaseVersionID == "" || in.ClientChangeID == "" || len(in.ClientChangeID) > maxClientChangeIDBytes {
		badRequest(c, fmt.Sprintf("pass base_version_id, a client_change_id of at most %d bytes, and replacements", maxClientChangeIDBytes))
		return
	}
	if len(in.Replacements) == 0 || len(in.Replacements) > textedit.MaxEdits {
		badRequest(c, fmt.Sprintf("pass between 1 and %d replacements", textedit.MaxEdits))
		return
	}
	for attempt := 1; ; attempt++ {
		out, created, err := h.saveSourceEdits(c.Request.Context(), docID, in, *current(c))
		// Another write landed after the read, so the replacements apply
		// again on top of it. When that write was this change, the next
		// attempt finds its version.
		if (errors.Is(err, repo.ErrVersionConflict) || errors.Is(err, repo.ErrConflict)) && attempt < editRebaseAttempts {
			continue
		}
		if err != nil {
			h.editFailed(c, err, false)
			return
		}
		if created {
			incVersion("edited", actorType(c))
			h.announceVersion(c, out.ID)
		}
		c.JSON(http.StatusCreated, out)
		return
	}
}

// saveSourceEdits applies the replacements to the current version and saves
// the result as the next one, unless the client change already made a
// version. It reports whether it made the version.
func (h handlers) saveSourceEdits(ctx context.Context, docID string, in editSourceRequest, author auth.Principal) (editSourceResponse, bool, error) {
	r := h.deps.repository
	d, err := r.GetDocument(ctx, docID)
	if err != nil {
		return editSourceResponse{}, false, err
	}
	// Look for the change after reading the current version. When that
	// version is the one the change made, the change is then found, and it
	// does not apply a second time.
	v, onto, err := r.VersionByClientChange(ctx, docID, in.ClientChangeID)
	if err == nil {
		out, err := h.sourceEdited(ctx, v, onto, in, nil, nil)
		return out, false, err
	}
	if !errors.Is(err, repo.ErrNotFound) {
		return editSourceResponse{}, false, err
	}
	onto = d.CurrentVersionID
	// The base must be a version of this document, so that the replacements
	// are only ever matched against it.
	if _, err := h.versionOf(ctx, docID, in.BaseVersionID); err != nil {
		return editSourceResponse{}, false, err
	}
	base, err := r.GetVersionHTML(ctx, in.BaseVersionID)
	if err != nil {
		return editSourceResponse{}, false, err
	}
	latest := base
	if onto != in.BaseVersionID {
		if latest, err = r.GetVersionHTML(ctx, onto); err != nil {
			return editSourceResponse{}, false, err
		}
	}
	edited, err := textedit.Merge(base, latest, in.Replacements)
	if err != nil {
		return editSourceResponse{}, false, &editMismatchError{err: err, versionID: onto}
	}
	summary := strings.TrimSpace(in.ChangeSummary)
	if summary == "" {
		summary = textedit.ReplacementSummary(base, in.Replacements)
	}
	if v, err = h.saveEdited(ctx, docID, onto, in.ClientChangeID, summary, edited, author); err != nil {
		return editSourceResponse{}, true, err
	}
	out, err := h.sourceEdited(ctx, v, onto, in, base, edited)
	return out, true, err
}

// sourceEdited describes v, the version that the replacements of in saved
// when they applied to onto. base and edited are the HTML of the base version
// and of v. A retry of a change does not have them, so they are read here
// when the answer names the changes of the other writers.
func (h handlers) sourceEdited(ctx context.Context, v repo.Version, onto string, in editSourceRequest, base, edited []byte) (editSourceResponse, error) {
	out := editSourceResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary, BaseVersionID: onto, Rebased: onto != in.BaseVersionID}
	if !out.Rebased {
		return out, nil
	}
	r := h.deps.repository
	var err error
	if base == nil {
		if base, err = r.GetVersionHTML(ctx, in.BaseVersionID); err != nil {
			return out, err
		}
		if edited, err = r.GetVersionHTML(ctx, v.ID); err != nil {
			return out, err
		}
	}
	// The HTML that the caller holds is the base with only its replacements.
	held, err := textedit.Merge(base, base, in.Replacements)
	if err != nil {
		return out, &editMismatchError{err: err, versionID: onto}
	}
	out.Others = textedit.Between(held, edited)
	return out, nil
}

// editFailed writes the response for an edit that saved nothing.
func (h handlers) editFailed(c *gin.Context, err error, hadBase bool) {
	var mismatch *editMismatchError
	var edit *textedit.Error
	var replacement *textedit.ReplacementError
	var conflict *repo.VersionConflictError
	switch {
	case errors.As(err, &mismatch) && errors.As(err, &edit):
		incVersion("edit_failed", actorType(c))
		c.JSON(http.StatusUnprocessableEntity, errorResponse("edit_failed", mismatch.Error(), editFailedDetails{Error: *edit, CurrentVersionID: mismatch.versionID}))
	case errors.As(err, &mismatch) && errors.As(err, &replacement):
		incVersion("edit_failed", actorType(c))
		c.JSON(http.StatusUnprocessableEntity, errorResponse("edit_failed", mismatch.Error(), replacementFailedDetails{ReplacementError: *replacement, CurrentVersionID: mismatch.versionID}))
	case errors.As(err, &conflict) && hadBase:
		versionConflict(c, err, "base_version_id is stale")
	case errors.As(err, &conflict):
		versionConflict(c, err, "the document changed while the edits were saved; try again")
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
	case errors.Is(err, errEditedTooLarge):
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", err.Error(), nil))
	default:
		internalErr(c, err)
	}
}

// restoreVersionRequest is the optional body of POST
// /v1/documents/{id}/versions/{version_id}/restore.
type restoreVersionRequest struct {
	ChangeSummary string `json:"change_summary,omitempty"`
}

// RestoreVersion godoc
// @Summary Restore version
// @Description Saves the content of an earlier version as the newest version, as an edit by the caller. History keeps every version, so a restore can itself be undone by restoring again.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID to restore"
// @Param body body restoreVersionRequest false "Change summary"
// @Success 201 {object} createVersionResponse
// @Failure 400 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope
// @Router /v1/documents/{id}/versions/{version_id}/restore [post]
func (h handlers) restoreVersion(c *gin.Context) {
	old, ok := h.loadVersion(c, repo.RoleEditor)
	if !ok {
		return
	}
	var in restoreVersionRequest
	if err := c.ShouldBindJSON(&in); err != nil && !errors.Is(err, io.EOF) {
		badRequest(c, "invalid restore request")
		return
	}
	ctx := c.Request.Context()
	d, err := h.deps.repository.GetDocument(ctx, old.DocumentID)
	if err != nil {
		internalErr(c, err)
		return
	}
	if d.CurrentVersionID == old.ID {
		badRequest(c, "that version is already the current version")
		return
	}
	html, err := h.deps.repository.GetVersionHTML(ctx, old.ID)
	if err != nil {
		internalErr(c, err)
		return
	}
	summary := strings.TrimSpace(in.ChangeSummary)
	if summary == "" {
		summary = restoredSummary(old)
	}
	v, err := h.deps.repository.CreateVersion(ctx, old.DocumentID, d.CurrentVersionID, "", summary, html, *current(c))
	if errors.Is(err, repo.ErrVersionConflict) {
		versionConflict(c, err, "the document changed while it was restored; try again")
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	incVersion("restored", actorType(c))
	h.announceVersion(c, v.ID)
	c.JSON(http.StatusCreated, createVersionResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary, BaseVersionID: d.CurrentVersionID})
}

// restoredSummary names a restore by the entry it brings back, with the
// words that History shows for that entry. A time would show in one time
// zone here and in the reader's own zone in the list. The entry follows a
// colon, not quotes, because its words can have quotes of their own.
func restoredSummary(old repo.Version) string {
	name, _, _ := strings.Cut(strings.TrimSpace(old.ChangeSummary), "\n")
	name = strings.TrimSpace(strings.TrimLeft(name, "-*• "))
	switch {
	case name != "":
	case old.Number == 1:
		name = "Created"
	default:
		name = "Edited"
	}
	return "Restored: " + name
}

// versionConflict writes the 409 for a stale base, naming the current version.
func versionConflict(c *gin.Context, err error, message string) {
	var details versionConflictDetails
	var conflict *repo.VersionConflictError
	if errors.As(err, &conflict) {
		details.CurrentVersionID = conflict.LatestVersionID
	}
	c.JSON(http.StatusConflict, errorResponse("version_conflict", message, details))
}

// CreateRenderToken godoc
// @Summary Create render token
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Success 200 {object} renderTokenResponse
// @Router /v1/documents/{id}/versions/{version_id}/render-token [post]
func (h handlers) createRenderToken(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	subject := renderAudiencePrefix + v.DocumentID + "/" + v.ID
	token := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SignForAudience(subject, "render", 5*time.Minute)
	renderPath := "/v/" + v.DocumentID + "/" + v.ID
	path := renderPath
	if h.deps.renderOrigin == "" || sameHTTPOrigin(h.deps.appOrigin, h.deps.renderOrigin) {
		//nolint:gosec // G124: Secure is conditional so explicit local HTTP development remains usable.
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     "slashdocs_render_token",
			Value:    token,
			Path:     renderPath,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureRenderCookie(c, h.deps.appOrigin),
			MaxAge:   300,
		})
	} else {
		path += "?token=" + url.QueryEscape(token)
	}
	if h.deps.renderOrigin != "" {
		path = strings.TrimRight(h.deps.renderOrigin, "/") + path
	}
	incRender("token_created", "success")
	c.JSON(http.StatusOK, renderTokenResponse{Token: token, URL: path})
}

func (h handlers) createPrintToken(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	subject := renderAudiencePrefix + v.DocumentID + "/" + v.ID
	token := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SignForAudience(subject, "print", 2*time.Minute)
	path := "/print/" + v.DocumentID + "/" + v.ID + "?token=" + url.QueryEscape(token)
	if h.deps.renderOrigin != "" {
		path = strings.TrimRight(h.deps.renderOrigin, "/") + path
	}
	c.JSON(http.StatusOK, renderTokenResponse{Token: token, URL: path})
}

func (h handlers) renderPrintVersion(c *gin.Context) {
	if h.deps.renderOrigin != "" && !hostMatchesOrigin(c.Request.Host, h.deps.renderOrigin) {
		notFound(c)
		return
	}
	docID, vid := c.Param("id"), c.Param("version_id")
	uid, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifyAudience(c.Query("token"), "print")
	if !ok || uid != renderAudiencePrefix+docID+"/"+vid {
		c.JSON(http.StatusUnauthorized, errorResponse("unauthorized", "invalid print token", nil))
		return
	}
	b, err := h.deps.repository.GetVersionHTML(c.Request.Context(), vid)
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	c.Header("Content-Security-Policy", "default-src 'none'; img-src * data: blob:; media-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline'; script-src 'unsafe-inline'; connect-src *; frame-ancestors 'none'; object-src 'none'")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "text/html; charset=utf-8", printableHTML(b))
}

// RenderVersion godoc
// @Summary Render version wrapper
// @Tags render
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Param token query string true "Render token"
// @Produce html
// @Success 200 {string} string
// @Router /v/{id}/{version_id} [get]
func (h handlers) renderVersion(c *gin.Context) {
	if h.deps.renderOrigin != "" && !hostMatchesOrigin(c.Request.Host, h.deps.renderOrigin) {
		notFound(c)
		return
	}
	docID, vid := c.Param("id"), c.Param("version_id")
	token := c.Query("token")
	if token == "" {
		if cookie, err := c.Request.Cookie("slashdocs_render_token"); err == nil {
			token = cookie.Value
		}
	}
	uid, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifyAudience(token, "render")
	if !ok || uid != renderAudiencePrefix+docID+"/"+vid {
		c.JSON(http.StatusUnauthorized, errorResponse("unauthorized", "invalid render token", nil))
		return
	}
	b, err := h.deps.repository.GetVersionHTML(c.Request.Context(), vid)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			incRender("rendered", "not_found")
			notFound(c)
			return
		}
		incRender("rendered", "error")
		internalErr(c, err)
		return
	}
	appOrigin := h.deps.appOrigin
	if appOrigin == "" {
		appOrigin = "'self'"
	}
	c.Header("Content-Security-Policy", render.CSP(appOrigin))
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	observeHTML("render", len(b))
	incRender("rendered", "success")
	c.Data(http.StatusOK, "text/html; charset=utf-8", render.Wrap(b, appOrigin))
}

func secureRenderCookie(c *gin.Context, appOrigin string) bool {
	if u, err := url.Parse(appOrigin); err == nil && strings.EqualFold(u.Scheme, "https") {
		return true
	}
	if c.Request.TLS != nil {
		return true
	}
	return strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
}

// ListVersions godoc
// @Summary List versions
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} listResponse[repo.Version]
// @Router /v1/documents/{id}/versions [get]
func (h handlers) listVersions(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	items, err := h.deps.repository.ListVersions(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.Version]{Items: items})
}

// DocumentChanges godoc
// @Summary Get the changes since a version
// @Description For the browser, which follows the document while other people edit it. Gives the replacements that turn the HTML of the version from into the HTML of the current version. start and end count UTF-8 bytes of the version from, and end is exclusive. live is true when the browser editor made every version after from. authors made those versions, and the author of the newest comes first. When from is the current version, replacements and authors are empty.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param from query string true "Version ID that the caller has"
// @Success 200 {object} documentChangesResponse
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope
// @Router /v1/documents/{id}/changes [get]
func (h handlers) documentChanges(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	out, err := h.changesFrom(c.Request.Context(), docID, c.Query("from"))
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

// changesFrom describes how the current version of the document differs
// from the version from, which must be a version of the document.
func (h handlers) changesFrom(ctx context.Context, docID, from string) (documentChangesResponse, error) {
	r := h.deps.repository
	d, err := r.GetDocument(ctx, docID)
	if err != nil {
		return documentChangesResponse{}, err
	}
	if _, err := h.versionOf(ctx, docID, from); err != nil {
		return documentChangesResponse{}, err
	}
	old, err := r.GetVersionHTML(ctx, from)
	if err != nil {
		return documentChangesResponse{}, err
	}
	latest := old
	if d.CurrentVersionID != from {
		if latest, err = r.GetVersionHTML(ctx, d.CurrentVersionID); err != nil {
			return documentChangesResponse{}, err
		}
	}
	authors, live, err := r.VersionAuthorsBetween(ctx, docID, from, d.CurrentVersionID)
	return documentChangesResponse{VersionID: d.CurrentVersionID, FromVersionID: from, Replacements: textedit.Between(old, latest), Live: live, Authors: authors}, err
}

// GetVersion godoc
// @Summary Get version metadata
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Success 200 {object} repo.Version
// @Router /v1/documents/{id}/versions/{version_id} [get]
func (h handlers) getVersion(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, v)
}

// loadVersionForViewer fetches the version named by the :version_id param,
// scoped to the document named by :id, and verifies the caller has at least
// viewer access to that document. It writes the appropriate error response
// and returns ok=false when any check fails.
func (h handlers) loadVersionForViewer(c *gin.Context) (repo.Version, bool) {
	return h.loadVersion(c, repo.RoleViewer)
}

// loadVersion is loadVersionForViewer for callers that need the given role.
func (h handlers) loadVersion(c *gin.Context, role repo.Role) (repo.Version, bool) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, role) {
		return repo.Version{}, false
	}
	v, err := h.deps.repository.GetVersion(c.Request.Context(), c.Param("version_id"))
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		internalErr(c, err)
		return repo.Version{}, false
	}
	if err != nil || v.DocumentID != docID {
		notFound(c)
		return repo.Version{}, false
	}
	return v, true
}

// GetVersionHTML godoc
// @Summary Get version HTML
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Produce html
// @Success 200 {string} string
// @Router /v1/documents/{id}/versions/{version_id}/html [get]
func (h handlers) getVersionHTML(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	b, err := h.deps.repository.GetVersionHTML(c.Request.Context(), v.ID)
	if err != nil {
		internalErr(c, err)
		return
	}
	observeHTML("version_download", len(b))
	incVersion("html_downloaded", actorType(c))
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", `attachment; filename="slashdocs-`+v.ID+`.html"`)
	c.Data(http.StatusOK, "text/html; charset=utf-8", b)
}
